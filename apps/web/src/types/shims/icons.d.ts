declare module 'virtual:icons/*' {
	import type { Component } from 'svelte';
	const component: Component<Record<string, unknown>>;
	export default component;
}
