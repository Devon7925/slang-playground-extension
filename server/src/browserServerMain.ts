/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createConnection, BrowserMessageReader, BrowserMessageWriter } from 'vscode-languageserver/browser';

import { InitializeParams, InitializeResult, TextDocuments, TextDocumentSyncKind, MarkupKind, DocumentSymbol, Location, SignatureHelp, CompletionItemKind, CompletionItem, SignatureInformation, ParameterInformation, TextDocumentContentChangeEvent } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';

import type { LanguageServer, MainModule, CompletionContext } from '../../media/slang-wasm';

// We'll set these after dynamic import
let slangd: LanguageServer;
let slangWasmModule: MainModule;


// Helper to resolve the correct URL for the WASM and JS files
function getPublicUrl(filename: string): string {
	// This will be replaced at runtime if extensionUri is provided
	return '/media/' + filename;
}

function getEmscriptenURI(uri: string): string {
	const prefix = "vscode-test-web://";
	if (uri.startsWith(prefix))
		uri = uri.slice(prefix.length)
	return uri;
}

function getSlangdURI(uri: string): string {
	return `file:///${getEmscriptenURI(uri)}`;
}

function vscodeURIFromSlangdURI(uri: string): string {
	const prefix = "file:///";
	if (uri.startsWith(prefix))
		uri = uri.slice(prefix.length)
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
let moduleReady: Promise<void> | null = null;
let extensionUri: string | undefined;
function getResourceUrl(filename: string): string {
	if (extensionUri) {
		// VS Code web extension: extensionUri points to the root, so join with /media/...
		return extensionUri.replace(/\/$/, '') + '/media/' + filename;
	}
	return getPublicUrl(filename);
}

function loadFileIntoEmscriptenFS(uri: string) {
	// Get relative path within the workspace
	const splitPath = uri.split("/")

	// Ensure directory structure in MEMFS
	const name = splitPath.pop()
	const dir = splitPath.join("/");
	let pathData = slangWasmModule.FS.analyzePath(uri, false);
	if (!pathData.parentExists) {
		slangWasmModule.FS.mkdir(dir);
	}


	// Write the actual file
	if(pathData.exists) {
		console.log("file already exists " + uri)
		return
	}
	slangWasmModule.FS.createDataFile(dir, name, new DataView(new ArrayBuffer(0)), true, true, false);
}

async function ensureSlangModuleLoaded() {
	if (moduleReady) return moduleReady;
	moduleReady = (async () => {
		// Dynamically import the JS glue code using extensionUri if available
		const slangWasmUrl = getResourceUrl('slang-wasm.js');
		const createModule = await import(/* @vite-ignore */ slangWasmUrl);
		// Patch the module config to use the correct WASM binary URL
		const moduleConfig = {
			locateFile(path: string) {
				if (path.endsWith('.wasm')) {
					return getResourceUrl('slang-wasm.wasm');
				}
				return path;
			}
		};
		// Actually instantiate the WASM module and create the language server
		slangWasmModule = await createModule.default(moduleConfig);
		slangd = slangWasmModule.createLanguageServer()!;
	})();
	return moduleReady;
}

/* from here on, all code is non-browser specific and could be shared with a regular extension */

connection.onInitialize(async (_params: InitializeParams): Promise<InitializeResult> => {
	// Accept extensionUri from initializationOptions
	if (_params.initializationOptions && _params.initializationOptions.extensionUri) {
		extensionUri = _params.initializationOptions.extensionUri;
	}
	try {
		await ensureSlangModuleLoaded();
	} catch (err) {
		console.error('Failed to load slang-wasm:', err);
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
connection.onCompletion(async (params, _token, _progress): Promise<CompletionItem[]> => {
	let lspContext: CompletionContext = {
		triggerKind: params.context!.triggerKind,
		triggerCharacter: params.context?.hasOwnProperty("triggerCharacter") ? (params.context?.triggerCharacter || "") : ""
	};
	const result = slangd.completion(params.textDocument.uri, params.position, lspContext);
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
	const result = slangd.hover(params.textDocument.uri, params.position);
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
	const result = slangd.gotoDefinition(params.textDocument.uri, params.position);
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
	const result = slangd.signatureHelp(params.textDocument.uri, params.position);
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
	const result = slangd.documentSymbol(params.textDocument.uri);
	if (!result || typeof result.size !== 'function' || typeof result.get !== 'function') return [];
	const symbols = [];
	for (let i = 0; i < result.size(); i++) {
		const sym = result.get(i);
		if (!sym) continue;
		symbols.push(convertDocumentSymbol(sym));
	}
	return symbols;
});

connection.onDidOpenTextDocument(async (params) => {
	const uri = params.textDocument.uri;
	const wasmURI = getSlangdURI(uri);
	const emscriptenURI = getEmscriptenURI(uri);
	loadFileIntoEmscriptenFS(emscriptenURI);
	slangd.didOpenTextDocument(wasmURI, params.textDocument.text);
});
// Diagnostics (textDocument/didChange, didOpen, didClose handled by TextDocuments)
connection.onDidChangeTextDocument(async (params) => {
	const uri = params.textDocument.uri;
	const wasmURI = getSlangdURI(uri)
	// Try to call didChangeTextDocument with just the text (if supported)
	try {
		// Try to construct a TextEditList as in MonacoEditor.vue
		let lspChanges = null;
		lspChanges = new slangWasmModule.TextEditList();
		for(const change of params.contentChanges) {
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
		const lspDiagnostics = [];
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

// Listen on the connection
connection.listen();
