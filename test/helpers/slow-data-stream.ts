import {Readable} from 'stream';
import {Clock} from '@sinonjs/fake-timers';
import delay = require('delay');

export default (clock?: Clock): Readable => {
	let i = 0;

	return new Readable({
		async read() {
			if (clock) {
				clock.tick(100);
			} else {
				await delay(100);
			}

			if (i++ < 10) {
				this.push('data\n'.repeat(100));
			} else {
				this.push(null);
			}
		}
	});
};
