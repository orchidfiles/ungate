import { startServer } from './server';

startServer().catch((err) => {
	console.error(err);
	process.exit(1);
});
