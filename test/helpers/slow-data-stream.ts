import {Readable} from 'stream';
import {Clock} from 'lolex';

export default (clock: Clock): Readable => {
	let i = 0;

	return new Readable({
		// @ts-ignore
		read() {
			if (i++ < 10) {
				this.push('data\n'.repeat(100));
				clock.tick(100);
			} else {
				this.push(null);
			}
		}
	});
};
