import process from 'node:process';
import React from 'react';
import { throttle } from 'es-toolkit/compat';
import ansiEscapes from 'ansi-escapes';
import isInCi from 'is-in-ci';
import autoBind from 'auto-bind';
import signalExit from 'signal-exit';
import patchConsole from 'patch-console';
import Yoga from 'yoga-layout';
import reconciler from './reconciler.js';
import render from './renderer.js';
import * as dom from './dom.js';
import logUpdate from './log-update.js';
import instances from './instances.js';
import App from './components/App.js';
const noop = () => { };
export default class Ink {
    options;
    log;
    throttledLog;
    altScreenActive;
    // Ignore last render after unmounting a tree to prevent empty output before exit
    isUnmounted;
    lastOutput;
    container;
    rootNode;
    cursorDeclaration;
    parkedCursor;
    // This variable is used only in debug mode to store full static output
    // so that it's rerendered every time, not just new static parts, like in non-debug mode
    fullStaticOutput;
    exitPromise;
    restoreConsole;
    unsubscribeResize;
    constructor(options) {
        autoBind(this);
        this.options = options;
        this.rootNode = dom.createNode('ink-root');
        this.rootNode.onComputeLayout = this.calculateLayout;
        this.rootNode.onRender = options.debug
            ? this.onRender
            : throttle(this.onRender, 32, {
                leading: true,
                trailing: true,
            });
        this.rootNode.onImmediateRender = this.onRender;
        this.log = logUpdate.create(options.stdout);
        this.throttledLog = options.debug
            ? this.log
            : throttle(this.log, undefined, {
                leading: true,
                trailing: true,
            });
        this.altScreenActive = false;
        // Ignore last render after unmounting a tree to prevent empty output before exit
        this.isUnmounted = false;
        // Store last output to only rerender when needed
        this.lastOutput = '';
        // This variable is used only in debug mode to store full static output
        // so that it's rerendered every time, not just new static parts, like in non-debug mode
        this.fullStaticOutput = '';
        this.cursorDeclaration = null;
        this.parkedCursor = null;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.container = reconciler.createContainer(this.rootNode, 
        // Legacy mode
        0, null, false, null, 'id', () => { }, null);
        // Unmount when process exits
        this.unsubscribeExit = signalExit(this.unmount, { alwaysLast: false });
        if (process.env['DEV'] === 'true') {
            reconciler.injectIntoDevTools({
                bundleType: 0,
                // Reporting React DOM's version, not Ink's
                // See https://github.com/facebook/react/issues/16666#issuecomment-532639905
                version: '16.13.1',
                rendererPackageName: 'ink',
            });
        }
        if (options.patchConsole) {
            this.patchConsole();
        }
        if (!isInCi) {
            options.stdout.on('resize', this.resized);
            this.unsubscribeResize = () => {
                options.stdout.off('resize', this.resized);
            };
        }
    }
    resized = () => {
        this.calculateLayout();
        this.onRender();
    };
    resolveExitPromise = () => { };
    rejectExitPromise = () => { };
    unsubscribeExit = () => { };
    restoreCursorToRenderBase() {
        if (!this.options.stdout.isTTY || !this.parkedCursor) {
            return;
        }
        if (this.parkedCursor.mode === 'absolute') {
            this.options.stdout.write(ansiEscapes.cursorTo(0, Math.max(0, this.parkedCursor.outputHeight - 1)));
            this.parkedCursor = null;
            return;
        }
        const down = Math.max(0, this.parkedCursor.outputHeight - this.parkedCursor.targetY);
        this.options.stdout.write((down > 0 ? ansiEscapes.cursorDown(down) : '') + ansiEscapes.cursorLeft);
        this.parkedCursor = null;
    }
    invalidatePrevFrame() {
        this.restoreCursorToRenderBase();
        if (!isInCi && !this.options.debug) {
            this.log.clear();
        }
        this.lastOutput = '';
    }
    enterAlternateScreen() {
        if (this.altScreenActive || isInCi || this.options.debug) {
            return;
        }
        this.invalidatePrevFrame();
        this.options.stdout.write('\u001B[?1049h\u001B[2J\u001B[H');
        this.altScreenActive = true;
    }
    exitAlternateScreen() {
        if (!this.altScreenActive || isInCi || this.options.debug) {
            return;
        }
        this.invalidatePrevFrame();
        this.options.stdout.write('\u001B[2J\u001B[H\u001B[?1049l');
        this.altScreenActive = false;
    }
    calculateLayout = () => {
        // The 'columns' property can be undefined or 0 when not using a TTY.
        // In that case we fall back to 80.
        const terminalWidth = this.options.stdout.columns || 80;
        this.rootNode.yogaNode.setWidth(terminalWidth);
        this.rootNode.yogaNode.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    };
    onRender = () => {
        if (this.isUnmounted) {
            return;
        }
        const { output, outputHeight, staticOutput } = render(this.rootNode);
        // If <Static> output isn't empty, it means new children have been added to it
        const hasStaticOutput = staticOutput && staticOutput !== '\n';
        if (this.options.debug) {
            if (hasStaticOutput) {
                this.fullStaticOutput += staticOutput;
            }
            this.options.stdout.write(this.fullStaticOutput + output);
            this.parkCursor(outputHeight);
            return;
        }
        if (isInCi) {
            if (hasStaticOutput) {
                this.options.stdout.write(staticOutput);
            }
            this.lastOutput = output;
            return;
        }
        if (hasStaticOutput) {
            this.fullStaticOutput += staticOutput;
        }
        if (outputHeight > this.options.stdout.rows) {
            this.parkedCursor = null;
            this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
            this.lastOutput = output;
            this.cursorDeclaration = null;
            return;
        }
        if (outputHeight === this.options.stdout.rows) {
            this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
            this.lastOutput = output;
            this.parkCursor(outputHeight, 'absolute');
            return;
        }
        // To ensure static output is cleanly rendered before main output, clear main output first
        if (hasStaticOutput) {
            this.restoreCursorToRenderBase();
            this.log.clear();
            this.options.stdout.write(staticOutput);
            this.log(output);
            this.parkCursor(outputHeight);
        }
        if (!hasStaticOutput && output !== this.lastOutput) {
            this.restoreCursorToRenderBase();
            this.throttledLog(output);
            this.parkCursor(outputHeight);
        }
        this.lastOutput = output;
    };
    render(node) {
        const tree = (React.createElement(App, { stdin: this.options.stdin, stdout: this.options.stdout, stderr: this.options.stderr, writeToStdout: this.writeToStdout, writeToStderr: this.writeToStderr, exitOnCtrlC: this.options.exitOnCtrlC, onExit: this.unmount, onCursorDeclaration: this.handleCursorDeclaration }, node));
        reconciler.updateContainer(tree, this.container, null, noop);
    }
    writeToStdout(data) {
        if (this.isUnmounted) {
            return;
        }
        if (this.options.debug) {
            this.options.stdout.write(data + this.fullStaticOutput + this.lastOutput);
            return;
        }
        if (isInCi) {
            this.options.stdout.write(data);
            return;
        }
        this.restoreCursorToRenderBase();
        this.log.clear();
        this.options.stdout.write(data);
        this.log(this.lastOutput);
    }
    writeToStderr(data) {
        if (this.isUnmounted) {
            return;
        }
        if (this.options.debug) {
            this.options.stderr.write(data);
            this.options.stdout.write(this.fullStaticOutput + this.lastOutput);
            return;
        }
        if (isInCi) {
            this.options.stderr.write(data);
            return;
        }
        this.restoreCursorToRenderBase();
        this.log.clear();
        this.options.stderr.write(data);
        this.log(this.lastOutput);
    }
    // eslint-disable-next-line @typescript-eslint/ban-types
    unmount(error) {
        if (this.isUnmounted) {
            return;
        }
        this.restoreCursorToRenderBase();
        this.unsubscribeExit();
        if (typeof this.restoreConsole === 'function') {
            this.restoreConsole();
        }
        if (typeof this.unsubscribeResize === 'function') {
            this.unsubscribeResize();
        }
        // CIs don't handle erasing ansi escapes well, so it's better to
        // only render last frame of non-static output
        if (isInCi) {
            this.options.stdout.write(this.lastOutput + '\n');
        }
        else if (!this.options.debug) {
            this.log.done();
        }
        this.isUnmounted = true;
        reconciler.updateContainer(null, this.container, null, noop);
        instances.delete(this.options.stdout);
        if (error instanceof Error) {
            this.rejectExitPromise(error);
        }
        else {
            this.resolveExitPromise();
        }
    }
    async waitUntilExit() {
        this.exitPromise ||= new Promise((resolve, reject) => {
            this.resolveExitPromise = resolve;
            this.rejectExitPromise = reject;
        });
        return this.exitPromise;
    }
    clear() {
        if (!isInCi && !this.options.debug) {
            this.restoreCursorToRenderBase();
            this.log.clear();
        }
    }
    handleCursorDeclaration = (declaration, clearIfNode) => {
        if (declaration) {
            this.cursorDeclaration = declaration;
            return;
        }
        if (!this.cursorDeclaration) {
            return;
        }
        if (clearIfNode && this.cursorDeclaration.node !== clearIfNode) {
            return;
        }
        this.cursorDeclaration = null;
    };
    resolveCursorTarget(outputHeight) {
        this.parkedCursor = null;
        if (!this.options.stdout.isTTY || !this.cursorDeclaration || outputHeight <= 0) {
            return null;
        }
        const node = this.cursorDeclaration.node;
        const baseX = typeof node.internal_absoluteX === 'number' ? node.internal_absoluteX : undefined;
        const baseY = typeof node.internal_absoluteY === 'number' ? node.internal_absoluteY : undefined;
        if (typeof baseX !== 'number' || typeof baseY !== 'number') {
            return null;
        }
        const targetX = Math.max(0, Math.min(baseX + this.cursorDeclaration.relativeX, Math.max(0, (this.options.stdout.columns || 1) - 1)));
        const targetY = baseY + this.cursorDeclaration.relativeY;
        if (!Number.isFinite(targetY) || targetY < 0 || targetY >= outputHeight) {
            return null;
        }
        return { targetX, targetY };
    }
    parkCursor(outputHeight, mode = 'relative') {
        const target = this.resolveCursorTarget(outputHeight);
        if (!target) {
            return;
        }
        if (mode === 'absolute') {
            this.options.stdout.write(ansiEscapes.cursorTo(target.targetX, target.targetY));
            this.parkedCursor = {
                outputHeight,
                targetY: target.targetY,
                mode: 'absolute',
            };
            return;
        }
        this.options.stdout.write(ansiEscapes.cursorUp(outputHeight - target.targetY) + ansiEscapes.cursorForward(target.targetX));
        this.parkedCursor = {
            outputHeight,
            targetY: target.targetY,
            mode: 'relative',
        };
    }
    patchConsole() {
        if (this.options.debug) {
            return;
        }
        this.restoreConsole = patchConsole((stream, data) => {
            if (stream === 'stdout') {
                this.writeToStdout(data);
            }
            if (stream === 'stderr') {
                const isReactMessage = data.startsWith('The above error occurred');
                if (!isReactMessage) {
                    this.writeToStderr(data);
                }
            }
        });
    }
}
//# sourceMappingURL=ink.js.map
