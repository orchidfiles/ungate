import { StaticTokenProvider } from './static-token-provider';

export class OpenAIProvider extends StaticTokenProvider {
	public constructor() {
		super('openai');
	}
}
