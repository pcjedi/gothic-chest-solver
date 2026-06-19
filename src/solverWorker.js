// Web Worker for Dijkstra solver
// Positions must stay in 1-7 at all intermediate steps
// Cost: moving same disc = 1 per step, switching disc = 1 + |disc_index_difference|

class MinHeap {
	constructor() {
		this.data = [];
	}
	push(item) {
		this.data.push(item);
		this._bubbleUp(this.data.length - 1);
	}
	pop() {
		const top = this.data[0];
		const last = this.data.pop();
		if (this.data.length > 0) {
			this.data[0] = last;
			this._sinkDown(0);
		}
		return top;
	}
	get length() {
		return this.data.length;
	}
	_bubbleUp(i) {
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (this.data[i][0] < this.data[parent][0]) {
				[this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
				i = parent;
			} else break;
		}
	}
	_sinkDown(i) {
		const n = this.data.length;
		while (true) {
			let smallest = i;
			const l = 2 * i + 1;
			const r = 2 * i + 2;
			if (l < n && this.data[l][0] < this.data[smallest][0]) smallest = l;
			if (r < n && this.data[r][0] < this.data[smallest][0]) smallest = r;
			if (smallest !== i) {
				[this.data[i], this.data[smallest]] = [
					this.data[smallest],
					this.data[i],
				];
				i = smallest;
			} else break;
		}
	}
}

function solve(startArr, matrixData, n) {
	const targetArr = Array(n).fill(4);

	const stateKey = (pos, lastDisc) => pos.join(",") + "|" + lastDisc;
	const posKey = (pos) => pos.join(",");

	const applyMove = (pos, disc, direction) => {
		const next = pos.slice();
		next[disc] += direction;
		if (next[disc] < 1 || next[disc] > 7) return null;
		for (let other = 0; other < n; other++) {
			if (other === disc) continue;
			const relation = matrixData[disc][other];
			if (relation !== 0) {
				next[other] += relation * direction;
				if (next[other] < 1 || next[other] > 7) return null;
			}
		}
		return next;
	};

	const dist = new Map();
	const prev = new Map();
	const startKey = stateKey(startArr, -1);
	dist.set(startKey, 0);

	const pq = new MinHeap();
	pq.push([0, startArr, -1]);
	const targetKey = posKey(targetArr);
	let foundKey = null;
	let visited = 0;

	while (pq.length > 0) {
		const [curCost, curPos, lastDisc] = pq.pop();

		const curKey = stateKey(curPos, lastDisc);
		if (curCost > (dist.get(curKey) ?? Infinity)) continue;

		visited++;

		if (posKey(curPos) === targetKey) {
			foundKey = curKey;
			break;
		}

		// Report progress every 50k states
		if (visited % 50000 === 0) {
			self.postMessage({ type: "progress", visited });
		}

		for (let disc = 0; disc < n; disc++) {
			for (const dir of [-1, 1]) {
				const next = applyMove(curPos, disc, dir);
				if (!next) continue;
				const switchCost =
					lastDisc === -1 || lastDisc === disc ? 0 : Math.abs(disc - lastDisc);
				const moveCost = 1 + switchCost;
				const newCost = curCost + moveCost;
				const nextKey = stateKey(next, disc);
				if (newCost < (dist.get(nextKey) ?? Infinity)) {
					dist.set(nextKey, newCost);
					prev.set(nextKey, { prevKey: curKey, disc, direction: dir });
					pq.push([newCost, next, disc]);
				}
			}
		}
	}

	if (!foundKey) return { steps: [], cost: Infinity, visited };

	// Reconstruct path
	const path = [];
	let k = foundKey;
	while (k !== startKey) {
		const info = prev.get(k);
		path.push({ disc: info.disc, direction: info.direction });
		k = info.prevKey;
	}
	path.reverse();

	// Build steps with positions
	const steps = [];
	let pos = startArr.slice();
	for (const { disc, direction } of path) {
		const stepPositions = {};
		for (let i = 0; i < n; i++) stepPositions[i] = pos[i];
		const next = applyMove(pos, disc, direction);
		steps.push({ move: { [disc]: next[disc] }, positions: stepPositions });
		pos = next;
	}

	const totalCost = dist.get(foundKey);
	return { steps, cost: totalCost, visited };
}

self.onmessage = (e) => {
	const { startArr, matrix, n } = e.data;
	const result = solve(startArr, matrix, n);
	self.postMessage({ type: "result", ...result });
};
