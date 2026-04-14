import { StaticTokenProvider } from './static-token-provider';

export class MiniMaxProvider extends StaticTokenProvider {
	public constructor() {
		super('minimax');
	}
}
