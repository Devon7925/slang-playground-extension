/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, Uri, commands, window, workspace } from 'vscode';
import * as vscode from 'vscode';
import { LanguageClientOptions } from 'vscode-languageclient';

import { LanguageClient } from 'vscode-languageclient/browser';
import type { CompilationResult, CompileRequest, EntrypointsRequest, EntrypointsResult, MaybeShader, PlaygroundRun, ServerInitializationOptions } from '../../shared/playgroundInterface';
import { checkShaderType } from "../../shared/util.js";

let client: LanguageClient;
const compileOptions = ['SPIRV', 'HLSL', 'GLSL', 'METAL', 'WGSL', 'CUDA'] as const;
type LanguageOptions = {
	languageId: string,
	requiresEntrypoint: boolean,
}
const compileOptionMap: { [k in (typeof compileOptions)[number]]: LanguageOptions } = {
	SPIRV: {
		languageId: 'spirv',
		requiresEntrypoint: false,
	},
	HLSL: {
		languageId: 'hlsl',
		requiresEntrypoint: true,
	},
	GLSL: {
		languageId: 'glsl',
		requiresEntrypoint: true,
	},
	METAL: {
		languageId: 'metal',
		requiresEntrypoint: false,
	},
	WGSL: {
		languageId: 'wgsl',
		requiresEntrypoint: false,
	},
	CUDA: {
		languageId: 'cuda-cpp',
		requiresEntrypoint: true
	}
}

async function getSlangFilesWithContents(): Promise<{ uri: string, content: string }[]> {
	const pattern = '**/*.slang';
	const files = await vscode.workspace.findFiles(pattern);

	const results: { uri: string, content: string }[] = [];

	for (const uri of files) {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			results.push({ uri: uri.toString(true), content: document.getText() });
		} catch (err) {
			console.error(`Failed to read ${uri.fsPath}:`, err);
		}
	}

	return results;
}

// this method is called when vs code is activated
export async function activate(context: ExtensionContext) {
	// Register Playground Run command to open a webview
	context.subscriptions.push(
		commands.registerCommand('slang.playgroundRun', async () => {
			const userSource = window.activeTextEditor.document.getText();
			const userURI = window.activeTextEditor.document.uri;

			const panel = window.createWebviewPanel(
				'slangPlayground',
				'Slang Playground',
				vscode.ViewColumn.Beside,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
				}
			);
			panel.webview.html = getPlaygroundWebviewContent(context, panel);
			const shaderType = checkShaderType(userSource);
			if (shaderType == null) {
				throw new Error("Error: In order to run the shader, please define either imageMain or printMain function in the shader code.");
			}
			if (shaderType === 'printMain') {
				const shaderOutputLog = vscode.window.createOutputChannel(`Slang Shader Output (${window.activeTextEditor.document.fileName})`);
				panel.webview.onDidReceiveMessage(message => {
					if (message.type === 'log') {
						console.log(`Shader Output: ${message.text}`);
						shaderOutputLog.append(message.text);
						shaderOutputLog.show(true);
					}
				});
				panel.onDidDispose(() => {
					shaderOutputLog.dispose();
				});
			}
			const entryPointName = shaderType;
			const ret = await compileShader(userSource, entryPointName, "WGSL");

			if (!ret.succ) {
				throw new Error("Error: Compilation failed.");
			}

			let message: PlaygroundRun = {
				userSource,
				ret,
				uri: panel.webview.asWebviewUri(userURI).toString()
			};
			panel.webview.postMessage(message)
		})
	);
	// Register a virtual document content provider for readonly docs
	const slangVirtualScheme = 'slang-virtual';
	const virtualDocumentContents = new Map();

	context.subscriptions.push(
		workspace.registerTextDocumentContentProvider(slangVirtualScheme, {
			provideTextDocumentContent: (uri) => {
				return virtualDocumentContents.get(uri.path.slice(1));
			}
		})
	);

	/*
	 * all except the code to create the language client in not browser specific
	 * and could be shared with a regular (Node) extension
	 */
	const documentSelector = [{ language: 'slang' }];

	const initializationOptions: ServerInitializationOptions = {
		extensionUri: context.extensionUri.toString(true),
		workspaceUris: vscode.workspace.workspaceFolders.map(folder => folder.uri.fsPath),
		files: await getSlangFilesWithContents(),
	}

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		documentSelector,
		synchronize: {},
		initializationOptions,
	};

	client = createWorkerLanguageClient(context, clientOptions);

	await client.start();

	// Register the user command
	context.subscriptions.push(commands.registerCommand('slang.compile', async () => {
		const targetSelection = await window.showQuickPick(compileOptions, {
			placeHolder: 'Select a Target',
		}) as (typeof compileOptions)[number] | undefined;
		if (!targetSelection) {
			return;
		}
		const userSource = window.activeTextEditor.document.getText() ?? '';
		let selectedEntrypoint = ""
		if (compileOptionMap[targetSelection].requiresEntrypoint) {
			// Send the picked option to the server and get the result
			const parameter: EntrypointsRequest = {
				sourceCode: userSource,
				shaderPath: window.activeTextEditor.document.uri.toString(true),
			}
			let entrypoints: EntrypointsResult = await client.sendRequest('slang/entrypoints', parameter);
			const entrypointSelection = await window.showQuickPick(entrypoints, {
				placeHolder: 'Select a Entrypoint',
			}) as (typeof compileOptions)[number] | undefined;
			if (!entrypointSelection) {
				return;
			}
			selectedEntrypoint = entrypointSelection;
		}
		// Send the picked option to the server and get the result
		const parameter: CompileRequest = {
			target: targetSelection,
			entrypoint: selectedEntrypoint,
			sourceCode: userSource,
			shaderPath: window.activeTextEditor.document.uri.toString(true),
			noWebGPU: true,
		}
		let result: CompilationResult = await client.sendRequest('slang/compile', parameter);
		const vDocName = `Slang Compile (${targetSelection})`
		// Show the result in a readonly virtual document
		const vdocUri = Uri.parse(`${slangVirtualScheme}:/${vDocName}`);
		virtualDocumentContents.set(vDocName, result[0]);
		const doc = await workspace.openTextDocument(vdocUri);
		await window.showTextDocument(doc, { preview: false, viewColumn: window.activeTextEditor?.viewColumn }).then(editor => {
			vscode.languages.setTextDocumentLanguage(doc, compileOptionMap[targetSelection].languageId);
		});
	}));

	context.subscriptions.push(commands.registerCommand('slang.reflection', async () => {
		const userSource = window.activeTextEditor.document.getText() ?? '';
		// Send the picked option to the server and get the result
		const parameter: CompileRequest = {
			target: "WGSL",
			entrypoint: "",
			sourceCode: userSource,
			shaderPath: window.activeTextEditor.document.uri.toString(true),
			noWebGPU: true,
		}
		let result: CompilationResult = await client.sendRequest('slang/compile', parameter);
		const vDocName = `Slang Reflection (${window.activeTextEditor.document.fileName.replace('\\', "")})`
		// Show the result in a readonly virtual document
		const vdocUri = Uri.parse(`${slangVirtualScheme}:/${vDocName}`);
		virtualDocumentContents.set(vDocName, JSON.stringify(result[3], undefined, 4));
		const doc = await workspace.openTextDocument(vdocUri);
		await window.showTextDocument(doc, { preview: false, viewColumn: window.activeTextEditor?.viewColumn }).then(editor => {
			vscode.languages.setTextDocumentLanguage(doc, "json");
		});
	}));

	context.subscriptions.push(commands.registerCommand('slang.playgroundDocumentation', async () => {
		const mdFile = vscode.Uri.joinPath(context.extensionUri, 'media', 'playgroundDocumentation.md')
  		await vscode.commands.executeCommand('markdown.showPreviewToSide', mdFile);
	}));
}

export async function deactivate(): Promise<void> {
	if (client !== undefined) {
		await client.stop();
	}
}

function createWorkerLanguageClient(context: ExtensionContext, clientOptions: LanguageClientOptions) {
	// Create a worker. The worker main file implements the language server.
	const serverMain = Uri.joinPath(context.extensionUri, 'server/dist/browserServerMain.js');
	const worker = new Worker(serverMain.toString(true));

	// create the language server client to communicate with the server running in the worker
	return new LanguageClient('lsp-web-extension-sample', 'LSP Web Extension Sample', clientOptions, worker);
}

export function getPlaygroundWebviewContent(context: ExtensionContext, panel: vscode.WebviewPanel): string {
	// Webview HTML with script tag for the esbuild webview bundle
	const webviewMain = panel.webview.asWebviewUri(Uri.joinPath(context.extensionUri, 'client/dist/webviewBundle.js'));
	const webviewStyle = panel.webview.asWebviewUri(Uri.joinPath(context.extensionUri, 'client/dist/webviewBundle.css'));
	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Slang Playground</title>
      	<link rel="stylesheet" href="${webviewStyle.toString(true)}">
		<script type="module" src="${webviewMain.toString(true)}"></script>
		<style>
			#app {
			    position: absolute;
				left: 0;
				right: 0;
				bottom: 0;
				top: 0;
			}
		</style>
	</head>
	<body>
	<div id="app">
		<p>Loading</p>
	</div>
	</body>
	</html>
`;
}

async function compileShader(userSource: string, entryPoint: string, compileTarget: (typeof compileOptions)[number]): Promise<MaybeShader> {
	// Send the picked option to the server and get the result
	const parameter: CompileRequest = {
		target: compileTarget,
		entrypoint: entryPoint,
		sourceCode: userSource,
		shaderPath: window.activeTextEditor.document.uri.toString(true),
		noWebGPU: false,
	}
	let compiledResult: CompilationResult = await client.sendRequest('slang/compile', parameter);

	// If compile is failed, we just clear the codeGenArea
	if (!compiledResult) {
		throw new Error("Compilation failed")
	}

	let [compiledCode, layout, hashedStrings, reflectionJsonObj, threadGroupSizes] = compiledResult;
	let reflectionJson = reflectionJsonObj;

	return { succ: true, code: compiledCode, layout: layout, hashedStrings, reflection: reflectionJson, threadGroupSizes };
}
