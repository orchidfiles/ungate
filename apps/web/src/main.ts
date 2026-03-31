import './app.css';
import { mount } from 'svelte';

import { postExtensionMessage } from '$shared/vscode';

import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app')! });

postExtensionMessage({ type: 'webview-ready' });

export default app;
