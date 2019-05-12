declare module 'lowercase-keys' {
	export default function(object: Record<string, string | string[] | number | boolean>): Record<string, string | string[] | number | boolean>;
}
