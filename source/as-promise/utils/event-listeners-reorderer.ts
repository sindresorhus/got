export default class EventListenerReorderer {
	isFirstCalled = false;
	waitPromise: Promise<void>;
	waitResolve?: (() => void);
	isWaitCalled = false;
	_ignoreSecond = false;

	constructor() {
		this.waitPromise = new Promise(resolve => {
			this.waitResolve = resolve;
		});
	}

	async callBarrier() {
		if (this.isWaitCalled) {
			this.waitResolve!();
		}

		this.isWaitCalled = true;

		return this.waitPromise;
	}

	ignoreSecond() {
		this._ignoreSecond = true;
	}

	firstWrapper(fn: (...p: any[]) => Promise<any>) {
		return (...parameters: any[]) => {
			this.isFirstCalled = true;
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

			if (this.isFirstCalled) {
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
