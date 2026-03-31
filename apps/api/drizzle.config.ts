import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/database/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	casing: 'snake_case',
	migrations: { prefix: 'none' }
});
