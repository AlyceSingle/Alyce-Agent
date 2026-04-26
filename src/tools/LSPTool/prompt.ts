export const LSP_TOOL_NAME = "LSP" as const;

export const DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on

Position-based operations also require:
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

Optional:
- query: Search text for workspaceSymbol
- maxResults: Maximum workspaceSymbol results, up to 500

documentSymbol and workspaceSymbol do not require line or character.

In Alyce this tool currently uses the TypeScript language service backend and supports TypeScript/JavaScript files (.ts, .tsx, .js, .jsx, .mts, .cts, .mjs, .cjs). If the file type is unsupported, an error is returned.`;
