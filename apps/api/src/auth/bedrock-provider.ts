import { StaticTokenProvider } from './static-token-provider';

export class BedrockProvider extends StaticTokenProvider {
	public constructor() {
		super('bedrock');
	}
}
