/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createConnection, BrowserMessageReader, BrowserMessageWriter } from 'vscode-languageserver/browser';

import { InitializeParams, InitializeResult, TextDocuments, TextDocumentSyncKind, MarkupKind, DocumentSymbol, Location, SignatureHelp, CompletionItemKind, CompletionItem, SignatureInformation, ParameterInformation, TextDocumentContentChangeEvent, Diagnostic } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import createModule from '../../media/slang-wasm.js';
import type { LanguageServer, MainModule, CompletionContext } from '../../media/slang-wasm';
import createSpirvModule from '../../media/spirv-tools.js';
import type { SpirvTools } from '../../media/spirv-tools';
import type { CompileRequest, EntrypointsRequest, EntrypointsResult, MaybeShader, ServerInitializationOptions } from '../../shared/playgroundInterface';
import playgroundSource from "./slang/playground.slang";

// We'll set these after dynamic import
let slangd: LanguageServer;
let compiler: SlangCompiler;
let slangWasmModule: MainModule;
let spirvWasmModule: SpirvTools;


// Helper to resolve the correct URL for the WASM and JS files
function removePrefix(data: string, prefix: string): string {
	if (data.startsWith(prefix))
		data = data.slice(prefix.length)
	return data;
}

function getEmscriptenURI(uri: string): string {
	uri = removePrefix(uri, "vscode-test-web://");
	uri = removePrefix(uri, "file:///");
	for (const workspaceUri in initializationOptions.workspaceUris) {
		uri = removePrefix(uri, workspaceUri.replaceAll('\\', '/').replaceAll(':', '%3A'));
	}
	return uri;
}

function getSlangdURI(uri: string): string {
	return `file:///${getEmscriptenURI(uri)}`;
}

function vscodeURIFromSlangdURI(uri: string): string {
	uri = removePrefix(uri, "file:///");
	return `vscode-test-web://${uri}`;
}

function convertDocumentSymbol(sym: any): DocumentSymbol {
	let children: DocumentSymbol[] = [];
	if (sym.children && typeof sym.children.size === 'function' && typeof sym.children.get === 'function') {
		for (let j = 0; j < sym.children.size(); j++) {
			const child = sym.children.get(j);
			if (child) children.push(convertDocumentSymbol(child));
		}
	} else if (Array.isArray(sym.children)) {
		children = sym.children.map(convertDocumentSymbol);
	}
	return {
		name: sym.name?.toString?.() ?? '',
		detail: sym.detail?.toString?.() ?? '',
		kind: sym.kind,
		range: sym.range,
		selectionRange: sym.selectionRange,
		children
	};
}


/* browser specific setup code */

const messageReader = new BrowserMessageReader(self);
const messageWriter = new BrowserMessageWriter(self);
const connection = createConnection(messageReader, messageWriter);

// // Dynamically import the WASM module and set up the language server
let initializationOptions: ServerInitializationOptions;

function loadFileIntoEmscriptenFS(uri: string, content: string) {
	// Ensure directory exists
	const splitPath = uri.split("/")
	splitPath.pop()
	const dir = splitPath.join("/");
	let pathData = slangWasmModule.FS.analyzePath(uri, false);
	if (!pathData.parentExists) {
		slangWasmModule.FS.createPath('/', dir, true, true);
	}

	// Write the actual file
	slangWasmModule.FS.writeFile(uri, content);
}

function applyIncrementalChange(
    text: string,
    change: TextDocumentContentChangeEvent
): string {
	if (!TextDocumentContentChangeEvent.isIncremental(change)) {
		return change.text;
	}
    const lines = text.split('\n');

    const startLine = change.range.start.line;
    const startChar = change.range.start.character;
    const endLine = change.range.end.line;
    const endChar = change.range.end.character;

    const before = lines.slice(0, startLine);
    const after = lines.slice(endLine + 1);

    const startLineText = lines[startLine] ?? '';
    const endLineText = lines[endLine] ?? '';

    const prefix = startLineText.substring(0, startChar);
    const suffix = endLineText.substring(endChar);

    const newLines = (change.text || '').split('\n');
    const middle = [...newLines];
    if (middle.length > 0) {
        middle[0] = prefix + middle[0];
        middle[middle.length - 1] = middle[middle.length - 1] + suffix;
    }

    return [...before, ...middle, ...after].join('\n');
}

function modifyEmscriptenFile(uri: string, changes: TextDocumentContentChangeEvent[]) {
	// Ensure directory exists
	
	let content = slangWasmModule.FS.readFile(uri).toString();
	for(const change of changes) {
		content = applyIncrementalChange(content, change)
	}
	slangWasmModule.FS.writeFile(uri, content);
}

let moduleReady: Promise<void> | null = null;
async function ensureSlangModuleLoaded() {
	if (slangd) return;
	if (moduleReady) return moduleReady;
	moduleReady = (async () => {
		// Instantiate the WASM module and create the language server
		slangWasmModule = await createModule();
        compiler = new SlangCompiler(slangWasmModule);
        let result = compiler.init();
		if(!result.ret) {
			console.error(`Failed to initialize compiler: ${result.msg}`)
		}
		slangd = slangWasmModule.createLanguageServer()!;
	})();
	return moduleReady;
}

let spirvModuleReady: Promise<void> | null = null;
async function ensureSpirvModuleLoaded() {
	if(spirvWasmModule) return;
	if (spirvModuleReady) return spirvModuleReady;
	spirvModuleReady = (async () => {
		// Instantiate the WASM module and create the language server
		spirvWasmModule = await createSpirvModule();
	})();
	return spirvModuleReady;
}

/* from here on, all code is non-browser specific and could be shared with a regular extension */

connection.onInitialize(async (_params: InitializeParams): Promise<InitializeResult> => {
	// Accept extensionUri from initializationOptions
	if (_params.initializationOptions) {
		initializationOptions = _params.initializationOptions;
	}
	try {
		await ensureSlangModuleLoaded();
	} catch (err) {
		console.error('Failed to load slang-wasm:', err);
	}

	for(const file of initializationOptions.files) {
		const emscriptenURI = getEmscriptenURI(file.uri);
		loadFileIntoEmscriptenFS(emscriptenURI, file.content);
	}

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: { triggerCharacters: [".", ":", ">", "(", "<", " ", "["] },
			hoverProvider: true,
			definitionProvider: true,
			signatureHelpProvider: { triggerCharacters: ['(', ','] },
			documentSymbolProvider: true,
		},
	};
});

// Track open, change and close text document events
const documents = new TextDocuments(TextDocument);
documents.listen(connection);

// --- LSP Handlers ---

// Completion
import { DiagnosticSeverity } from 'vscode-languageserver';
import { SlangCompiler } from './compiler';
connection.onCompletion(async (params, _token, _progress): Promise<CompletionItem[]> => {
	const wasmURI = getSlangdURI(params.textDocument.uri);
	let lspContext: CompletionContext = {
		triggerKind: params.context!.triggerKind,
		triggerCharacter: params.context?.hasOwnProperty("triggerCharacter") ? (params.context?.triggerCharacter || "") : ""
	};
	const result = slangd.completion(wasmURI, params.position, lspContext);
	if (result == undefined) {
		return [];
	}
	const items: CompletionItem[] = [];
	for (let i = 0; i < result.size(); i++) {
		const item = result.get(i);
		if (!item) continue;
		// Only use LSP fields
		items.push({
			label: item.label.toString(),
			kind: item.kind as CompletionItemKind,
			detail: item.detail.toString(),
			documentation: item.documentation?.toString() ?? '',
			data: item.data,
			insertText: item.label.toString(),
		});
	}
	return items;
});

// Hover
connection.onHover(async (params, _token) => {
	const wasmURI = getSlangdURI(params.textDocument.uri);
	const result = slangd.hover(wasmURI, params.position);
	if (!result) return null;
	return {
		contents: {
			kind: MarkupKind.Markdown,
			value: result.contents.value.toString()
		},
		range: result.range
	};
});

// Definition
connection.onDefinition(async (params, _token) => {
	const wasmURI = getSlangdURI(params.textDocument.uri);
	const result = slangd.gotoDefinition(wasmURI, params.position);
	if (!result) return null;

	const arr: Location[] = [];
	for (let i = 0; i < result.size(); i++) {
		let loc = result.get(i);
		if (!loc) throw new Error("Invalid state")
		arr.push({
			...loc,
			uri: vscodeURIFromSlangdURI(loc.uri.toString())
		});
	}
	return arr;
});

// Signature Help
connection.onSignatureHelp(async (params, _token): Promise<SignatureHelp | null> => {
	const wasmURI = getSlangdURI(params.textDocument.uri);
	const result = slangd.signatureHelp(wasmURI, params.position);
	if (!result) return null;

	const sigs: SignatureInformation[] = [];
	for (let i = 0; i < result.signatures.size(); i++) {
		let lspSignature = result.signatures.get(i);
		if (lspSignature == undefined) {
			throw new Error("Invalid state!");
		}
		let params: ParameterInformation[] = [];
		for (let j = 0; j < lspSignature.parameters.size(); j++) {
			let lspParameter = lspSignature.parameters.get(j);
			if (lspParameter == undefined) {
				throw new Error("Invalid state!");
			}
			params.push({
				label: [lspParameter.label[0], lspParameter.label[1]],
				documentation: lspParameter.documentation.value.toString()
			});
		}
		let signature: SignatureInformation = {
			label: lspSignature.label.toString(),
			documentation: lspSignature.documentation.value.toString(),
			parameters: params
		};
		sigs.push(signature);
	}
	return { ...result, signatures: sigs };
});

// Document Symbols
connection.onDocumentSymbol(async (params, _token) => {
	const wasmURI = getSlangdURI(params.textDocument.uri);
	const result = slangd.documentSymbol(wasmURI);
	if (!result || typeof result.size !== 'function' || typeof result.get !== 'function') return [];
	const symbols = [];
	for (let i = 0; i < result.size(); i++) {
		const sym = result.get(i);
		if (!sym) continue;
		symbols.push(convertDocumentSymbol(sym));
	}
	return symbols;
});

// This whole technique is somewhat hacky, but I'm not sure there's a better way to make playground imports work
const loadedPlaygroundFiles: Set<string> = new Set();
function openPlayground(wasmURI: string) {
	let splitUri = wasmURI.split('/');
	splitUri.pop(); // Remove the file name
	const playgroundURI = splitUri.join('/') + '/playground.slang';
	if (loadedPlaygroundFiles.has(playgroundURI)) {
		return; // Already opened
	}
	const emscriptenPlaygroundURI = removePrefix(playgroundURI, "file:///");
	loadedPlaygroundFiles.add(playgroundURI);
	slangd.didOpenTextDocument(playgroundURI, playgroundSource);
	loadFileIntoEmscriptenFS(emscriptenPlaygroundURI, playgroundSource);
	console.log("Loading playground file " + playgroundURI);
}

connection.onDidOpenTextDocument(async (params) => {
	const uri = params.textDocument.uri;
	const wasmURI = getSlangdURI(uri);
	const emscriptenURI = getEmscriptenURI(uri);
	loadFileIntoEmscriptenFS(emscriptenURI, params.textDocument.text);
	slangd.didOpenTextDocument(wasmURI, params.textDocument.text);
	
	openPlayground(wasmURI)
});
// Diagnostics (textDocument/didChange, didOpen, didClose handled by TextDocuments)
connection.onDidChangeTextDocument(async (params) => {
	const uri = params.textDocument.uri;
	const wasmURI = getSlangdURI(uri)
	const emscriptenURI = getEmscriptenURI(uri);
	modifyEmscriptenFile(emscriptenURI, params.contentChanges);
	// Try to call didChangeTextDocument with just the text (if supported)
	try {
		// Try to construct a TextEditList as in MonacoEditor.vue
		let lspChanges = null;
		lspChanges = new slangWasmModule.TextEditList();
		for (const change of params.contentChanges) {
			if (TextDocumentContentChangeEvent.isIncremental(change))
				lspChanges.push_back(change);
			else
				console.error("Change should be incremental but isn't")
		}
		slangd.didChangeTextDocument(wasmURI, lspChanges);
		if (lspChanges.delete) lspChanges.delete();
		const diagnostics = slangd.getDiagnostics?.(wasmURI);
		if (!diagnostics || typeof diagnostics.size !== 'function' || typeof diagnostics.get !== 'function') {
			connection.sendDiagnostics({ uri, diagnostics: [] });
			return;
		}
		const lspDiagnostics: Diagnostic[] = [];
		for (let i = 0; i < diagnostics.size(); i++) {
			const d = diagnostics.get(i);
			if (!d) continue;
			lspDiagnostics.push({
				range: d.range,
				message: d.message?.toString?.() ?? '',
				severity: typeof d.severity === 'number' ? (d.severity as DiagnosticSeverity) : DiagnosticSeverity.Error,
				code: d.code?.toString?.() ?? '',
				source: 'slang',
			});
		}
		connection.sendDiagnostics({ uri, diagnostics: lspDiagnostics });
	} catch (e) {
		console.error(e)
		connection.sendDiagnostics({ uri, diagnostics: [] });
	}
});

connection.onRequest('slang/compile', async (params: CompileRequest): Promise<MaybeShader> => {
	let path = getEmscriptenURI(params.shaderPath);
	let compilation = compiler.compile(params.sourceCode, path, params.entrypoint, params.target, params.noWebGPU);
	if(compilation.succ == false) return compilation;
	if(params.target === "SPIRV") {
		await ensureSpirvModuleLoaded();
        let disAsmCode = spirvWasmModule.dis(
            compilation.code as any,// todo improve typing
            spirvWasmModule.SPV_ENV_UNIVERSAL_1_3,
            spirvWasmModule.SPV_BINARY_TO_TEXT_OPTION_INDENT |
            spirvWasmModule.SPV_BINARY_TO_TEXT_OPTION_FRIENDLY_NAMES
        );


        if (disAsmCode == "Error") {
			return {
				succ: false,
				message: "Failed to get spirv string representation"
			};
        }

		compilation.code = disAsmCode;
	}
	return compilation;
});

connection.onRequest('slang/entrypoints', async (params: EntrypointsRequest): Promise<EntrypointsResult> => {
	let path = getEmscriptenURI(params.shaderPath);
	return compiler.findDefinedEntryPoints(params.sourceCode, path)
});

// Listen on the connection
connection.listen();
