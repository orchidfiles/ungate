import { describe, expect, it } from 'vitest';

import { NgrokLogLine } from '../../src/ngrok-log-line';
import { NgrokOutputLines } from '../../src/ngrok-output-lines';

/** Lines captured from ngrok 3.39.13 run as `ngrok http <port> --log stdout --log-format json`. */
const REAL_LINES = {
	malformedTokenSession:
		'{"t":"2026-11-23T17:19:45-0700","lvl":"eror","msg":"failed to reconnect session","obj":"tunnels.session","err":"authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.\\nInstructions to install your authtoken are on your ngrok dashboard:\\nhttps://dashboard.ngrok.com/get-started/your-authtoken\\r\\n\\r\\nERR_NGROK_105\\r\\n"}',
	malformedTokenTerminating:
		'{"t":"2026-11-23T17:19:45-0700","lvl":"info","msg":"ERROR terminating with error obj=app err=\\"authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.\\\\nInstructions to install your authtoken are on your ngrok dashboard:\\\\nhttps://dashboard.ngrok.com/get-started/your-authtoken\\\\r\\\\n\\\\r\\\\nERR_NGROK_105\\\\r\\\\n\\""}',
	malformedTokenCommandFailed:
		'{"t":"2026-11-23T17:19:45-0700","lvl":"crit","msg":"command failed","err":"authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.\\nInstructions to install your authtoken are on your ngrok dashboard:\\nhttps://dashboard.ngrok.com/get-started/your-authtoken\\r\\n\\r\\nERR_NGROK_105\\r\\n"}',
	noTokenSession:
		'{"t":"2026-11-23T17:19:18-0700","lvl":"eror","msg":"failed to reconnect session","obj":"tunnels.session","err":"authentication failed: This ngrok session is not authenticated. ngrok requires an account and a valid credential to start a session.\\n\\nSign up for an account: https://dashboard.ngrok.com/signup\\nGet your credential: https://dashboard.ngrok.com/get-started/your-authtoken\\r\\n\\r\\nERR_NGROK_4018\\r\\n"}',
	updateCheckWarning:
		'{"t":"2026-11-23T17:33:53-0700","lvl":"warn","msg":"failed to check for update","obj":"updater","err":"Post \\"https://update.ngrok-agent.com/check\\": context deadline exceeded"}',
	webService:
		'{"t":"2026-11-23T17:19:45-0700","lvl":"info","msg":"starting web service","obj":"web","addr":"127.0.0.1:4040","allow_hosts":null}',
	stderrSignup: 'ERROR:  Sign up for an account: https://dashboard.ngrok.com/signup',
	stderrDashboardLink: 'ERROR:  https://dashboard.ngrok.com/get-started/your-authtoken\r',
	stderrCode: 'ERROR:  ERR_NGROK_105\r',
	stderrDocsLink: 'ERROR:  https://ngrok.com/docs/errors/err_ngrok_105\r',
	stderrReason: 'ERROR:  authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.',
	stderrBlank: 'ERROR:  \r'
};

describe('NgrokLogLine', () => {
	it('reads the tunnel url only from the started tunnel event', () => {
		const started = new NgrokLogLine(
			'{"t":"2026-11-23T17:40:00-0700","lvl":"info","msg":"started tunnel","obj":"tunnels","name":"command_line","addr":"http://localhost:58917","url":"https://acre-case-gibberish.ngrok-free.dev"}'
		);

		expect(started.tunnelUrl).toBe('https://acre-case-gibberish.ngrok-free.dev');
		expect(started.level).toBe('info');
		expect(started.failure).toBeNull();
	});

	it('never takes a url from free text, another event or an http address', () => {
		expect(new NgrokLogLine('started tunnel https://stable.ngrok-free.dev').tunnelUrl).toBeNull();
		expect(new NgrokLogLine('{"lvl":"info","msg":"open stream","url":"https://stable.ngrok-free.dev"}').tunnelUrl).toBeNull();
		expect(new NgrokLogLine('{"lvl":"info","msg":"started tunnel","url":"http://stable.ngrok-free.dev"}').tunnelUrl).toBeNull();
		expect(new NgrokLogLine('{"lvl":"info","msg":"started tunnel","url":"tcp://0.tcp.ngrok.io:1234"}').tunnelUrl).toBeNull();
		expect(new NgrokLogLine('{"lvl":"info","msg":"started tunnel"').tunnelUrl).toBeNull();
	});

	it("refuses ngrok's own site even inside a started tunnel event", () => {
		expect(new NgrokLogLine('{"lvl":"info","msg":"started tunnel","url":"https://dashboard.ngrok.com"}').tunnelUrl).toBeNull();
		expect(new NgrokLogLine('{"lvl":"info","msg":"started tunnel","url":"https://ngrok.com/docs"}').tunnelUrl).toBeNull();
	});

	it('finds no tunnel url in any real authentication failure line', () => {
		for (const line of Object.values(REAL_LINES)) {
			expect(new NgrokLogLine(line).tunnelUrl).toBeNull();
		}
	});

	it('reads the error code and reason from real json failure lines', () => {
		expect(new NgrokLogLine(REAL_LINES.malformedTokenSession).failure).toEqual({
			code: 'ERR_NGROK_105',
			message: 'authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.'
		});
		expect(new NgrokLogLine(REAL_LINES.malformedTokenCommandFailed).failure?.code).toBe('ERR_NGROK_105');
		expect(new NgrokLogLine(REAL_LINES.noTokenSession).failure).toEqual({
			code: 'ERR_NGROK_4018',
			message:
				'authentication failed: This ngrok session is not authenticated. ngrok requires an account and a valid credential to start a session.'
		});
	});

	it('reads real plain stderr lines one fact at a time', () => {
		expect(new NgrokLogLine(REAL_LINES.stderrReason).failure).toEqual({
			code: null,
			message: 'authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.'
		});
		expect(new NgrokLogLine(REAL_LINES.stderrCode).failure).toEqual({ code: 'ERR_NGROK_105', message: null });
		expect(new NgrokLogLine(REAL_LINES.stderrDashboardLink).failure).toBeNull();
		expect(new NgrokLogLine(REAL_LINES.stderrBlank).failure).toBeNull();
		expect(new NgrokLogLine(REAL_LINES.stderrDocsLink).failure).toBeNull();
	});

	it("maps ngrok's level names, including its eror spelling", () => {
		expect(new NgrokLogLine(REAL_LINES.malformedTokenSession).level).toBe('error');
		expect(new NgrokLogLine(REAL_LINES.malformedTokenCommandFailed).level).toBe('error');
		expect(new NgrokLogLine(REAL_LINES.updateCheckWarning).level).toBe('warn');
		expect(new NgrokLogLine(REAL_LINES.webService).level).toBe('info');
		expect(new NgrokLogLine(REAL_LINES.malformedTokenTerminating).level).toBe('info');
		expect(new NgrokLogLine(REAL_LINES.stderrCode).level).toBe('error');
	});

	it('does not treat a warning as a failure', () => {
		expect(new NgrokLogLine(REAL_LINES.updateCheckWarning).failure).toBeNull();
		expect(new NgrokLogLine(REAL_LINES.malformedTokenTerminating).failure).toBeNull();
	});
});

describe('NgrokOutputLines', () => {
	it('joins a line split across chunks and drops blank lines', () => {
		const lines = new NgrokOutputLines();

		expect(lines.push('{"msg":"started tunnel","url":"https://acre-')).toEqual([]);
		expect(lines.push('case.ngrok-free.dev"}\n\n{"msg":"next"}\npart')).toEqual([
			'{"msg":"started tunnel","url":"https://acre-case.ngrok-free.dev"}',
			'{"msg":"next"}'
		]);
		expect(lines.flush()).toEqual(['part']);
		expect(lines.flush()).toEqual([]);
	});
});
