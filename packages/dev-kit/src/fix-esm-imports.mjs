import fs from 'fs';
import path from 'path';

function fixFile(file) {
	let code = fs.readFileSync(file, 'utf8');
	const dir = path.dirname(file);

	// import ... from './x' or '../x' (relative paths)
	code = code.replace(/from\s+(['"])(\.[^'"]+)\1/g, (m, quote, spec) => {
		const ext = path.extname(spec);
		// already has .js/.mjs/.cjs — skip
		if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return m;

		const fileCandidate = path.resolve(dir, spec + '.js');
		const indexCandidate = path.resolve(dir, spec, 'index.js');

		if (fs.existsSync(fileCandidate)) {
			return `from ${quote}${spec}.js${quote}`;
		}

		if (fs.existsSync(indexCandidate)) {
			return `from ${quote}${spec}/index.js${quote}`;
		}

		return m;
	});

	// import ... from '..' or '.'
	code = code.replace(/from\s+(['"])(\.{1,2})\1/g, (m, quote, spec) => {
		const indexCandidate = path.resolve(dir, spec, 'index.js');

		if (fs.existsSync(indexCandidate)) {
			return `from ${quote}${spec}/index.js${quote}`;
		}

		return m;
	});

	// import('./x') or import('../x')
	code = code.replace(/import\((['"])(\.[^'"]+)\1\)/g, (m, quote, spec) => {
		const ext = path.extname(spec);
		if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return m;

		const fileCandidate = path.resolve(dir, spec + '.js');
		const indexCandidate = path.resolve(dir, spec, 'index.js');

		if (fs.existsSync(fileCandidate)) {
			return `import(${quote}${spec}.js${quote})`;
		}

		if (fs.existsSync(indexCandidate)) {
			return `import(${quote}${spec}/index.js${quote})`;
		}

		return m;
	});

	// import('.'), import('..')
	code = code.replace(/import\((['"])(\.{1,2})\1\)/g, (m, quote, spec) => {
		const indexCandidate = path.resolve(dir, spec, 'index.js');

		if (fs.existsSync(indexCandidate)) {
			return `import(${quote}${spec}/index.js${quote})`;
		}

		return m;
	});

	fs.writeFileSync(file, code);
}

function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (entry.isFile() && full.endsWith('.js')) fixFile(full);
	}
}

const target = process.argv[2];
if (!target) {
	console.error('Error. Usage: node fix-esm-imports.mjs <dir>');
	process.exit(1);
}

walk(path.resolve(process.cwd(), target));
