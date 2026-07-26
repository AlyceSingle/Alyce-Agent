import assert from "node:assert/strict";
import { createLazyPtyManager } from "./lazyServices.js";

function runTests() {
  testReadOnlyAccessorsWorkBeforeAnySession();
  testCloseAllStaysAnOperationOnUnusedManager();
  testSessionLifecycle();
  console.log("lazyServices tests passed");
}

// 回归：早先的实现从未调用它的 loader，于是每个方法都抛
// "PTY manager has not been loaded yet."，五个 PTY 工具全部不可用。
function testReadOnlyAccessorsWorkBeforeAnySession() {
  const manager = createLazyPtyManager({ workspaceRoot: process.cwd() });

  assert.deepEqual(manager.listSessions(), []);
  assert.equal(manager.getSession("missing"), undefined);
}

// 从未用过 PTY 的会话退出时不应顺手实例化 manager。
function testCloseAllStaysAnOperationOnUnusedManager() {
  const manager = createLazyPtyManager({ workspaceRoot: process.cwd() });

  assert.deepEqual(manager.closeAll(), []);
}

function testSessionLifecycle() {
  const manager = createLazyPtyManager({ workspaceRoot: process.cwd() });
  const session = manager.createSession({});

  try {
    assert.ok(session.id.length > 0);
    assert.equal(manager.listSessions().length, 1);
    assert.equal(manager.getSession(session.id)?.id, session.id);

    // 写入与改尺寸不应抛错；输出到达是异步的，这里不断言内容。
    manager.writeSession(session.id, "\r");
    manager.resizeSession(session.id, 100, 30);
    assert.equal(typeof manager.readSession(session.id, {}).content, "string");
  } finally {
    manager.closeSession(session.id);
  }

  assert.equal(manager.listSessions().length, 0);
}

runTests();
