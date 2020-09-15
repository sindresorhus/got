import {Readable} from 'stream';
import {Clock} from '@sinonjs/fake-timers';

export default (clock: Clock): Readable => {
	let i = 0;

	return new Readable({
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
