// esbuild.config.mjs
// Basic config for building both client and server
import esbuild from 'esbuild';

async function buildAll() {
	try {
		// Build client
		await esbuild.build({
			entryPoints: ['client/src/browserClientMain.ts'],
			bundle: true,
			outfile: 'client/dist/browserClientMain.js',
			platform: 'browser',
			sourcemap: true,
			target: ['es2020'],
			format: 'cjs',
			tsconfig: 'client/tsconfig.json',
			define: { 'process.env.NODE_ENV': '"production"' },
			external: ['vscode'],
		});

		// Build server
		await esbuild.build({
			entryPoints: ['server/src/browserServerMain.ts'],
			bundle: true,
			outfile: 'server/dist/browserServerMain.js',
			platform: 'browser',
			sourcemap: true,
			target: ['es2020'],
			format: 'cjs',
			tsconfig: 'server/tsconfig.json',
			define: { 'process.env.NODE_ENV': '"production"' },
			external: [],
			loader: {
				'.slang': 'text',
			},
		});
	} catch (err) {
		// Use globalThis.console for ESM compatibility
		if (typeof globalThis.console !== 'undefined') {
			globalThis.console.error(err);
		}
		// Exit with error code for CI/CD (works in Node.js only)
		if (typeof globalThis.process !== 'undefined' && globalThis.process.exit) {
			globalThis.process.exit(1);
		}
		throw err;
	}
}

buildAll();
