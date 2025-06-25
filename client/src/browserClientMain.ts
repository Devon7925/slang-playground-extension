/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, Uri, commands, window, workspace } from 'vscode';
import * as vscode from 'vscode';
import { LanguageClientOptions } from 'vscode-languageclient';

import { LanguageClient } from 'vscode-languageclient/browser';
import type { Bindings, CompilationResult, CompileRequest, HashedStringData, MaybeShader, PlaygroundRun, ReflectionJSON } from '../../shared/playgroundInterface';
import { CallCommand, checkShaderType, getResourceCommandsFromAttributes, getUniformControllers, getUniformSize, parseCallCommands, RUNNABLE_ENTRY_POINT_NAMES } from "../../shared/util.js";

let client: LanguageClient;
const compileOptions = ['SPIRV', 'METAL', 'WGSL'] as const;
const compileOptionMap: { [k in (typeof compileOptions)[number]]: string } = {
	SPIRV: 'spirv',
	METAL: 'metal',
	WGSL: 'wgsl'
}

// this method is called when vs code is activated
export async function activate(context: ExtensionContext) {
	// Register Playground Run command to open a webview
	context.subscriptions.push(
		commands.registerCommand('slang.playgroundRun', async () => {
			const panel = window.createWebviewPanel(
				'slangPlayground',
				'Slang Playground',
				vscode.ViewColumn.Beside,
				{
					enableScripts: true,
					retainContextWhenHidden: true,
				}
			);
			panel.webview.html = getPlaygroundWebviewContent(context);

			const userSource = window.activeTextEditor.document.getText();
			const shaderType = checkShaderType(userSource);
			if (shaderType == null) {
				throw new Error("Error: In order to run the shader, please define either imageMain or printMain function in the shader code.");
			}

			const entryPointName = shaderType;
			const ret = await compileShader(userSource, entryPointName, "WGSL");

			if(!ret.succ) {
				throw new Error("Error: Compilation failed.");
			}
			
			let message: PlaygroundRun = {
				userSource,
				ret,
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

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		documentSelector,
		synchronize: {},
		initializationOptions: {
			extensionUri: context.extensionUri.toString(true)
		}
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
		// Send the picked option to the server and get the result
		const parameter: CompileRequest = {
			target: targetSelection,
			sourceCode: window.activeTextEditor.document.getText() ?? '',
			noWebGPU: true,
		}
		let result: CompilationResult = await client.sendRequest('slang/compile', parameter);
		const vDocName = `Slang Compile (${targetSelection})`
		// Show the result in a readonly virtual document
		const vdocUri = Uri.parse(`${slangVirtualScheme}:/${vDocName}`);
		virtualDocumentContents.set(vDocName, result[0]);
		const doc = await workspace.openTextDocument(vdocUri);
		await window.showTextDocument(doc, { preview: false, viewColumn: window.activeTextEditor?.viewColumn }).then(editor => {
			vscode.languages.setTextDocumentLanguage(doc, compileOptionMap[targetSelection]);
		});
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

export function getPlaygroundWebviewContent(context: ExtensionContext): string {
	// Webview HTML with script tag for the esbuild webview bundle
	const webviewMain = Uri.joinPath(context.extensionUri, 'client/dist/webviewBundle.js');
	const webviewStyle = Uri.joinPath(context.extensionUri, 'client/dist/webviewBundle.css');
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
		sourceCode: window.activeTextEditor.document.getText() ?? '',
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
