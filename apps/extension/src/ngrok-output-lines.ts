/** Reassembles complete lines from a process stream whose chunks may end mid-line. */
export class NgrokOutputLines {
	private pending = '';

	push(chunk: string): string[] {
		const parts = `${this.pending}${chunk}`.split('\n');

		this.pending = parts.pop() ?? '';

		return parts.filter((line) => line.trim());
	}

	flush(): string[] {
		const rest = this.pending;

		this.pending = '';

		return rest.trim() ? [rest] : [];
	}
}
