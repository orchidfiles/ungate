import { ProviderSettings } from './database/provider-settings';
import { requireCredentialChannel } from './security/credential-channel';
import { startServer } from './server';

async function bootstrap(): Promise<void> {
	// Nothing may start without the extension credential channel: it is the only source of
	// provider credentials, and the legacy migration must not blank a column it cannot drain.
	requireCredentialChannel();

	await ProviderSettings.migrateLegacySecrets();
	await startServer();
}

bootstrap().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
