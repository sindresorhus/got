export default class EventListenerReorderer {
	firstCalled = false;
	waitPromise: Promise<any>;
	waitResolve: any;
	waitCalled = false;
	_ignoreSecond = false;

	constructor() {
		this.waitPromise = new Promise(resolve => {
			this.waitResolve = resolve;
		});
	}

	async callBarrier() {
		if (this.waitCalled) {
			this.waitResolve();
		}

		this.waitCalled = true;

		return this.waitPromise;
	}

	ignoreSecond() {
		this._ignoreSecond = true;
	}

	firstWrapper(fn: (...p: any[]) => Promise<any>) {
		return (...parameters: any[]) => {
			this.firstCalled = true;
			(async () => {
				await fn(...parameters);

				this.callBarrier();
			})();
		};
	}

	secondWrapper(fn: (...p: any[]) => Promise<void>) {
		return (...parameters: any[]) => {
			if (this._ignoreSecond) {
				return;
			}

			if (this.firstCalled) {
				(async () => {
					await this.callBarrier();

					if (this._ignoreSecond) {
						return;
					}

					await fn(...parameters);
				})();
			} else {
				fn(...parameters);
			}
		};
	}
}
