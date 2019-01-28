import {Hooks} from '../known-hook-events';

export interface Options {
	hooks?: Partial<Hooks>;
	decompress?: boolean;
	encoding?: BufferEncoding | null;
	method?: string;
	[ key: string ]: unknown | Options;
}
