import { useCallback, useRef, useState } from "react";
import "./App.css";
import SolverWorker from "./solverWorker.js?worker";

const showDebug =
	new URLSearchParams(window.location.search).get("debug") === "true";

function App() {
	const [count, setCount] = useState(7);
	const [phase, setPhase] = useState(1); // 1=start positions, 2=relation input
	const [selections, setSelections] = useState({});
	const [startPositions, setStartPositions] = useState({});
	const [currentPositions, setCurrentPositions] = useState({});
	const [resolved, setResolved] = useState(() => Array(7).fill(false));
	const [matrix, setMatrix] = useState(() =>
		Array.from({ length: 7 }, (_, i) =>
			Array.from({ length: 7 }, (_, j) => (i === j ? 1 : 0)),
		),
	);
	const [testingDisc, setTestingDisc] = useState(0);
	const [movementPlan, setMovementPlan] = useState([]);
	const [autoApplyStep, setAutoApplyStep] = useState(null); // { disc, endPos, newPositions }
	const [solvePlan, setSolvePlan] = useState(null); // computed in phase 3
	const [solving, setSolving] = useState(false);
	const [solveProgress, setSolveProgress] = useState(0);
	const [solveStepIndex, setSolveStepIndex] = useState(0);
	const workerRef = useRef(null);

	const addGroup = () => {
		const n = count + 1;
		setCount(n);
		setResolved((prev) => [...prev, false]);
		setMatrix((prev) => {
			const expanded = prev.map((row) => [...row, 0]);
			const newRow = Array(n).fill(0);
			newRow[n - 1] = 1;
			expanded.push(newRow);
			return expanded;
		});
	};

	const removeGroup = (idx) => {
		if (count <= 1) return;
		const newCount = count - 1;
		setCount(newCount);
		// Shift selections after removed index
		const newSelections = {};
		for (let i = 0; i < count; i++) {
			if (i === idx) continue;
			const newI = i > idx ? i - 1 : i;
			if (selections[i] !== undefined) newSelections[newI] = selections[i];
		}
		setSelections(newSelections);
		const newResolved = [...resolved];
		newResolved.splice(idx, 1);
		setResolved(newResolved);
		const newMatrix = matrix
			.filter((_, i) => i !== idx)
			.map((row) => row.filter((_, j) => j !== idx));
		setMatrix(newMatrix);

		// Auto-transition to phase 2 if all remaining discs have selections
		if (Object.keys(newSelections).length === newCount) {
			const starts = {};
			for (let i = 0; i < newCount; i++) {
				starts[i] = newSelections[i];
			}
			setStartPositions(starts);
			setCurrentPositions({ ...starts });
			const initialResolved = Array(newCount).fill(false);
			const initialMatrix = Array.from({ length: newCount }, (_, i) =>
				Array.from({ length: newCount }, (_, j) => (i === j ? 1 : 0)),
			);
			setResolved(initialResolved);
			setMatrix(initialMatrix);
			// Find first disc to test (highest edge disc, or highest index)
			let firstDisc = -1;
			for (let i = newCount - 1; i >= 0; i--) {
				if (starts[i] === 1 || starts[i] === 7) {
					firstDisc = i;
					break;
				}
			}
			if (firstDisc === -1) firstDisc = newCount - 1;
			const pos = starts[firstDisc];
			const direction = pos <= 4 ? 1 : -1;
			const endPos = pos + direction;
			setMovementPlan([
				{ move: { [firstDisc]: endPos }, positions: { ...starts } },
			]);
			setTestingDisc(firstDisc);
			const initSelections = {};
			initSelections[firstDisc] = endPos;
			setSelections(initSelections);
			setPhase(2);
		}
	};

	// Launch solver in web worker
	const startSolving = useCallback(
		(positions, currentMatrix) => {
			// Kill previous worker if any
			if (workerRef.current) workerRef.current.terminate();
			setSolving(true);
			setSolveProgress(0);
			setSolvePlan(null);
			setPhase(3);

			const n = count;
			const startArr = [];
			for (let i = 0; i < n; i++) startArr.push(positions[i]);

			const worker = new SolverWorker();
			workerRef.current = worker;
			worker.onmessage = (e) => {
				if (e.data.type === "progress") {
					setSolveProgress(e.data.visited);
				} else if (e.data.type === "result") {
					setSolving(false);
					setSolvePlan({ steps: e.data.steps, cost: e.data.cost });
					setSolveStepIndex(0);
					// Compute first condensed+merged step positions for initial display
					const steps = e.data.steps;
					if (steps.length > 0) {
						// Collapse same-disc, then merge independent
						const collapsed = [];
						let si = 0;
						while (si < steps.length) {
							const disc = parseInt(Object.keys(steps[si].move)[0]);
							let lastIdx = si;
							while (
								lastIdx + 1 < steps.length &&
								parseInt(Object.keys(steps[lastIdx + 1].move)[0]) === disc
							) {
								lastIdx++;
							}
							let posAfter;
							if (lastIdx + 1 < steps.length) {
								posAfter = { ...steps[lastIdx + 1].positions };
							} else {
								posAfter = {};
								for (let d = 0; d < n; d++) posAfter[d] = 4;
							}
							collapsed.push({ discs: [disc], positions: posAfter });
							si = lastIdx + 1;
						}
						// Merge first group using accumulator
						const merged = {
							discs: [...collapsed[0].discs],
							positions: collapsed[0].positions,
						};
						for (let j = 1; j < collapsed.length; j++) {
							let canMerge = true;
							for (const d1 of merged.discs) {
								for (const d2 of collapsed[j].discs) {
									if (
										currentMatrix[d1][d2] !== 0 ||
										currentMatrix[d2][d1] !== 0
									) {
										canMerge = false;
										break;
									}
								}
								if (!canMerge) break;
							}
							if (canMerge) {
								merged.discs = [...merged.discs, ...collapsed[j].discs];
								merged.positions = collapsed[j].positions;
							} else {
								break;
							}
						}
						setSelections(merged.positions);
					}
					worker.terminate();
					workerRef.current = null;
				}
			};
			worker.postMessage({ startArr, matrix: currentMatrix, n });
		},
		[count],
	);

	// Unified disc recommendation logic
	// Returns { disc, endPos, autoApply } or null if all resolved
	// lastTested = -1 means first move (tiebreaker: highest index)
	const getRecommendation = (
		positions,
		currentResolved,
		lastTested,
		currentMatrix,
	) => {
		// Count how many discs are at edge positions (1 or 7) after a simulated move
		// Returns Infinity if any disc would land on a blocking position (0 or 8)
		const countEdgesAfterMove = (disc, direction) => {
			const simPositions = { ...positions };
			simPositions[disc] = positions[disc] + direction;
			for (let other = 0; other < count; other++) {
				if (other === disc) continue;
				const relation = currentMatrix[disc][other];
				if (relation !== 0) {
					simPositions[other] = positions[other] + relation * direction;
				}
			}
			for (let i = 0; i < count; i++) {
				if (simPositions[i] <= 0 || simPositions[i] >= 8) return Infinity;
			}
			let edges = 0;
			for (let i = 0; i < count; i++) {
				if (simPositions[i] === 1 || simPositions[i] === 7) edges++;
			}
			return edges;
		};

		// Count known (non-zero, non-self) entries in a disc's matrix row
		const getMovingInfo = (disc) => {
			let info = 0;
			for (let j = 0; j < count; j++) {
				if (j === disc) continue;
				if (currentMatrix[disc][j] !== 0) info++;
			}
			return info;
		};

		// Collect edge discs and unresolved discs
		const edgeDiscs = [];
		const allUnresolved = [];
		for (let i = 0; i < count; i++) {
			if (positions[i] === 1 || positions[i] === 7) edgeDiscs.push(i);
			if (!currentResolved[i]) allUnresolved.push(i);
		}
		if (allUnresolved.length === 0) return null;

		// Helper: check if a disc can move in some direction without OOB
		const canDiscMove = (posArr, disc) => {
			for (const dir of [-1, 1]) {
				const np = posArr[disc] + dir;
				if (np < 1 || np > 7) continue;
				let valid = true;
				for (let other = 0; other < count; other++) {
					if (other === disc) continue;
					const relation = currentMatrix[disc][other];
					if (relation !== 0) {
						const op = posArr[other] + relation * dir;
						if (op < 1 || op > 7) {
							valid = false;
							break;
						}
					}
				}
				if (valid) return true;
			}
			return false;
		};

		// Helper: find best valid move for an unresolved disc (prefer toward center, fewest edges)
		const pickUnresolvedMove = (disc) => {
			const pos = positions[disc];
			let bestDir = null;
			let bestEdges = Infinity;
			for (const dir of [-1, 1]) {
				const newPos = pos + dir;
				if (newPos < 1 || newPos > 7) continue;
				const edges = countEdgesAfterMove(disc, dir);
				if (edges === Infinity) continue;
				const towardCenter = (pos <= 4 && dir === 1) || (pos > 4 && dir === -1);
				// Prefer fewer edges, then toward center
				if (
					edges < bestEdges ||
					(edges === bestEdges && towardCenter && bestDir !== null)
				) {
					bestEdges = edges;
					bestDir = dir;
				}
			}
			if (bestDir === null) return null;
			return { disc, endPos: pos + bestDir, autoApply: false };
		};

		// Helper: pick best unresolved disc from a set (edge first, most info, then tiebreak)
		const pickBestUnresolved = (candidates) => {
			if (candidates.length === 0) return null;
			const sorted = [...candidates].sort((a, b) => {
				const edgeA = positions[a] === 1 || positions[a] === 7 ? 0 : 1;
				const edgeB = positions[b] === 1 || positions[b] === 7 ? 0 : 1;
				if (edgeA !== edgeB) return edgeA - edgeB;
				const infoA = getMovingInfo(a);
				const infoB = getMovingInfo(b);
				if (infoA !== infoB) return infoB - infoA;
				const distA = lastTested === -1 ? -a : Math.abs(a - lastTested);
				const distB = lastTested === -1 ? -b : Math.abs(b - lastTested);
				return distA !== distB ? distA - distB : b - a;
			});
			for (const disc of sorted) {
				const move = pickUnresolvedMove(disc);
				if (move) return move;
			}
			return null;
		};

		// --- Case 1: No discs at edge position → recommend testing an unresolved disc ---
		if (edgeDiscs.length === 0) {
			return pickBestUnresolved(allUnresolved);
		}

		// --- Case 2: Exactly one unresolved edge disc and no resolved disc at edge → test that one ---
		const unresolvedEdge = edgeDiscs.filter((d) => !currentResolved[d]);
		const resolvedAtEdge = edgeDiscs.some((d) => currentResolved[d]);
		if (unresolvedEdge.length === 1 && !resolvedAtEdge) {
			const move = pickUnresolvedMove(unresolvedEdge[0]);
			if (move) return move;
		}

		// --- Case 3: Unresolved disc with info that can move → test it ---
		const posArr = [];
		for (let i = 0; i < count; i++) posArr.push(positions[i]);
		const movableInfoDiscs = allUnresolved.filter(
			(d) => getMovingInfo(d) > 0 && canDiscMove(posArr, d),
		);
		if (movableInfoDiscs.length > 0) {
			const move = pickBestUnresolved(movableInfoDiscs);
			if (move) return move;
		}

		// --- Case 4: BFS with resolved discs to reach case 1, 2, or 3 ---
		const blockedDiscs = allUnresolved.filter(
			(d) => getMovingInfo(d) > 0 && !canDiscMove(posArr, d),
		);
		const resolvedDiscs = [];
		for (let i = 0; i < count; i++) {
			if (currentResolved[i]) resolvedDiscs.push(i);
		}

		if (resolvedDiscs.length > 0) {
			const posKey = (p) => p.join(",");
			const startState = posArr;

			// Count current edges
			let currentEdgeCount = 0;
			for (let i = 0; i < count; i++) {
				if (posArr[i] === 1 || posArr[i] === 7) currentEdgeCount++;
			}

			const applyMoveArr = (state, disc, dir) => {
				const next = state.slice();
				next[disc] += dir;
				if (next[disc] < 1 || next[disc] > 7) return null;
				for (let other = 0; other < count; other++) {
					if (other === disc) continue;
					const relation = currentMatrix[disc][other];
					if (relation !== 0) {
						next[other] += relation * dir;
						if (next[other] < 1 || next[other] > 7) return null;
					}
				}
				return next;
			};

			const isGoalState = (state) => {
				// (a) no disc at edge position at all
				for (let i = 0; i < count; i++) {
					if (state[i] === 1 || state[i] === 7) break;
					if (i === count - 1) return true;
				}

				// (b) a previously blocked disc is now unblocked
				for (const d of blockedDiscs) {
					if (canDiscMove(state, d)) return true;
				}

				// (c) exactly one disc at edge, and it's unresolved
				let totalEdges = 0;
				let unresolvedEdgeCount = 0;
				for (let i = 0; i < count; i++) {
					if (state[i] === 1 || state[i] === 7) {
						totalEdges++;
						if (!currentResolved[i]) unresolvedEdgeCount++;
					}
				}
				if (totalEdges === 1 && unresolvedEdgeCount === 1) return true;

				return false;
			};

			// BFS with progressively relaxed edge threshold
			const maxDepth = 4;
			let found = null;

			for (
				let allowedEdges = 0;
				allowedEdges < currentEdgeCount && !found;
				allowedEdges++
			) {
				const visited = new Set();
				visited.add(posKey(startState));
				let queue = [{ state: startState, firstMove: null }];

				for (let depth = 0; depth < maxDepth && !found; depth++) {
					const nextQueue = [];
					for (const { state, firstMove } of queue) {
						for (const disc of resolvedDiscs) {
							for (const dir of [-1, 1]) {
								const next = applyMoveArr(state, disc, dir);
								if (!next) continue;
								const key = posKey(next);
								if (visited.has(key)) continue;
								visited.add(key);
								const move = firstMove || { disc, direction: dir };
								// Check strict goals first
								if (isGoalState(next)) {
									found = move;
									break;
								}
								// Check relaxed goal: fewer edges than allowed threshold
								let edgeCount = 0;
								for (let i = 0; i < count; i++) {
									if (next[i] === 1 || next[i] === 7) edgeCount++;
								}
								if (edgeCount <= allowedEdges) {
									found = move;
									break;
								}
								nextQueue.push({ state: next, firstMove: move });
							}
							if (found) break;
						}
						if (found) break;
					}
					queue = nextQueue;
				}
			}

			if (found) {
				const endPos = positions[found.disc] + found.direction;
				return { disc: found.disc, endPos, autoApply: true };
			}
		}

		// --- Fallback: pick unresolved disc with a valid move ---
		return pickBestUnresolved(allUnresolved);
	};

	// Compute matrix row and resolved from current selections in phase 2
	const computeMatrixFromSelections = (
		newSelections,
		currentMatrix,
		currentResolved,
	) => {
		const testedPos = currentPositions[testingDisc];
		const newTestedPos = newSelections[testingDisc];
		if (newTestedPos === undefined)
			return { matrix: currentMatrix, resolved: currentResolved };

		const direction = newTestedPos - testedPos; // +1 or -1
		if (direction === 0)
			return { matrix: currentMatrix, resolved: currentResolved };

		const newMatrix = currentMatrix.map((row) => [...row]);
		let allKnown = true;

		for (let i = 0; i < count; i++) {
			if (i === testingDisc) {
				newMatrix[testingDisc][i] = 1;
				continue;
			}
			if (newSelections[i] !== undefined) {
				const diff = newSelections[i] - currentPositions[i];
				const relation = diff / direction;
				// Only update if previously unknown or consistent with existing
				if (
					newMatrix[testingDisc][i] === 0 ||
					newMatrix[testingDisc][i] === relation
				) {
					newMatrix[testingDisc][i] = relation;
				}
			} else {
				// Only mark unknown if we don't already have data
				if (newMatrix[testingDisc][i] === 0) {
					allKnown = false;
				}
			}
		}

		const newResolved = [...currentResolved];
		newResolved[testingDisc] = allKnown;

		return { matrix: newMatrix, resolved: newResolved };
	};

	const handleOptionChange = (groupIndex, value) => {
		const newSelections = { ...selections, [groupIndex]: value };
		setSelections(newSelections);

		if (phase === 1 && Object.keys(newSelections).length === count) {
			const starts = {};
			for (let i = 0; i < count; i++) {
				starts[i] = newSelections[i];
			}
			setStartPositions(starts);
			setCurrentPositions({ ...starts });
			const initialResolved = Array(count).fill(false);
			const initialMatrix = Array.from({ length: count }, (_, i) =>
				Array.from({ length: count }, (_, j) => (i === j ? 1 : 0)),
			);
			setMatrix(initialMatrix);
			const rec = getRecommendation(starts, initialResolved, -1, initialMatrix);
			if (rec) {
				setMovementPlan([
					{ move: { [rec.disc]: rec.endPos }, positions: { ...starts } },
				]);
				setupRelationTest(starts, rec.disc, rec.endPos);
			}
		} else if (phase === 2) {
			// Immediately update matrix and resolved on every click
			const { matrix: newMatrix, resolved: newResolved } =
				computeMatrixFromSelections(newSelections, matrix, resolved);
			setMatrix(newMatrix);
			setResolved(newResolved);
		}
	};

	const handleUndoSelection = (groupIndex) => {
		const newSelections = { ...selections };
		delete newSelections[groupIndex];
		setSelections(newSelections);

		if (phase === 2) {
			// Recalculate matrix without this selection
			const { matrix: newMatrix, resolved: newResolved } =
				computeMatrixFromSelections(newSelections, matrix, resolved);
			setMatrix(newMatrix);
			setResolved(newResolved);
		}
	};

	const handleForward = () => {
		if (phase === 1 && Object.keys(selections).length === count) {
			const starts = {};
			for (let i = 0; i < count; i++) {
				starts[i] = selections[i];
			}
			setStartPositions(starts);
			setCurrentPositions({ ...starts });
			const initialResolved = Array(count).fill(false);
			const initialMatrix = Array.from({ length: count }, (_, i) =>
				Array.from({ length: count }, (_, j) => (i === j ? 1 : 0)),
			);
			setMatrix(initialMatrix);
			const rec = getRecommendation(starts, initialResolved, -1, initialMatrix);
			if (rec) {
				setMovementPlan([
					{ move: { [rec.disc]: rec.endPos }, positions: { ...starts } },
				]);
				setupRelationTest(starts, rec.disc, rec.endPos);
			}
		}
	};

	const setupRelationTest = (positions, discIdx, endPos) => {
		setTestingDisc(discIdx);
		const newPos =
			endPos !== undefined
				? endPos
				: positions[discIdx] + (positions[discIdx] <= 4 ? 1 : -1);

		const newSelections = {};
		newSelections[discIdx] = newPos; // pre-select the tested disc's new position
		setSelections(newSelections);
		setPhase(2);
	};

	const handleConfirmRelation = () => {
		// If this is an auto-apply step, just commit the pre-computed positions
		if (autoApplyStep) {
			const newPositions = autoApplyStep.newPositions;
			setCurrentPositions(newPositions);
			setAutoApplyStep(null);

			if (resolved.every((b) => b)) {
				startSolving(startPositions, matrix);
			} else {
				advanceToNext(newPositions, resolved, matrix, [...movementPlan]);
			}
			return;
		}

		// Build new positions from selections; unselected discs stay at current position
		const newPositions = { ...currentPositions };
		const hasBlocking = Object.entries(selections).some(
			([idx, val]) => parseInt(idx) !== testingDisc && (val === 0 || val === 8),
		);
		if (!hasBlocking) {
			// Normal move: commit all selections as new positions
			for (let i = 0; i < count; i++) {
				if (selections[i] !== undefined) {
					newPositions[i] = selections[i];
				}
			}
		}
		// If blocking: positions stay unchanged (disc didn't actually move)

		// Auto-fill unselected non-tested discs as "no change" for matrix computation
		const fullSelections = { ...selections };
		for (let i = 0; i < count; i++) {
			if (fullSelections[i] === undefined) {
				fullSelections[i] = currentPositions[i];
			}
		}
		const { matrix: newMatrix, resolved: newResolvedFromMatrix } =
			computeMatrixFromSelections(fullSelections, matrix, resolved);
		setMatrix(newMatrix);

		// Commit positions and mark this disc as tested
		// But don't mark as resolved if blocking positions were selected
		setCurrentPositions(newPositions);
		const newResolved = [...newResolvedFromMatrix];
		if (hasBlocking) {
			newResolved[testingDisc] = false;
		} else {
			newResolved[testingDisc] = true;
		}
		setResolved(newResolved);

		// Check if all discs are fully determined
		if (newResolved.every((b) => b)) {
			startSolving(startPositions, newMatrix);
		} else {
			// Advance to next recommendation, auto-applying resolved disc moves
			advanceToNext(newPositions, newResolved, newMatrix, [...movementPlan]);
		}
	};

	// Auto-apply resolved disc moves: show one at a time, don't silently skip
	const advanceToNext = (positions, currentResolved, currentMatrix, plan) => {
		const pos = { ...positions };
		const lastDisc = testingDisc;

		const rec = getRecommendation(
			pos,
			currentResolved,
			lastDisc,
			currentMatrix,
		);
		if (!rec) {
			setMovementPlan(plan);
			startSolving(startPositions, currentMatrix);
			return;
		}

		plan.push({ move: { [rec.disc]: rec.endPos }, positions: { ...pos } });

		if (rec.autoApply) {
			// Compute resulting positions
			const direction = rec.endPos - pos[rec.disc];
			const newPos = { ...pos };
			newPos[rec.disc] = rec.endPos;
			for (let other = 0; other < count; other++) {
				if (other === rec.disc) continue;
				const relation = currentMatrix[rec.disc][other];
				if (relation !== 0) {
					newPos[other] = pos[other] + relation * direction;
				}
			}
			// Show the step visually: pre-fill all selections
			const newSelections = {};
			for (let i = 0; i < count; i++) {
				newSelections[i] = newPos[i];
			}
			setSelections(newSelections);
			setTestingDisc(rec.disc);
			setCurrentPositions(pos);
			setMovementPlan(plan);
			setAutoApplyStep({ disc: rec.disc, newPositions: newPos });
			setPhase(2);
		} else {
			// Unresolved disc: needs user input
			setCurrentPositions(pos);
			setMovementPlan(plan);
			setAutoApplyStep(null);
			setupRelationTest(pos, rec.disc, rec.endPos);
		}
	};

	const isSelectableInPhase2 = (groupIndex, optionIndex) => {
		if (groupIndex === testingDisc) return false;
		const prevPos = currentPositions[groupIndex];
		const adjacent = optionIndex === prevPos - 1 || optionIndex === prevPos + 1;
		if (!adjacent) return false;

		// Check if any other non-tested disc already has a selection
		const hasBlockingSelection = Object.entries(selections).some(
			([idx, val]) => parseInt(idx) !== testingDisc && (val === 0 || val === 8),
		);
		const hasNonBlockingSelection = Object.entries(selections).some(
			([idx, val]) =>
				parseInt(idx) !== testingDisc &&
				val !== undefined &&
				val !== 0 &&
				val !== 8,
		);

		const isBlocking = optionIndex === 0 || optionIndex === 8;

		if (hasBlockingSelection && !isBlocking) return false;
		if (hasNonBlockingSelection && isBlocking) return false;

		return true;
	};

	const handleRefresh = () => {
		if (workerRef.current) {
			workerRef.current.terminate();
			workerRef.current = null;
		}
		setSolving(false);
		const positions = { ...startPositions };
		setCurrentPositions(positions);
		setMovementPlan([]);
		setAutoApplyStep(null);
		setSolvePlan(null);
		const plan = [];
		advanceToNext(positions, resolved, matrix, plan);
	};

	const handleBack = () => {
		if (phase === 2) {
			setPhase(1);
			setSelections(startPositions);
			setAutoApplyStep(null);
			setCurrentPositions({ ...startPositions });
			setResolved(Array(count).fill(false));
			setMatrix(
				Array.from({ length: count }, (_, i) =>
					Array.from({ length: count }, (_, j) => (i === j ? 1 : 0)),
				),
			);
			setMovementPlan([]);
		} else if (phase === 3) {
			if (workerRef.current) {
				workerRef.current.terminate();
				workerRef.current = null;
			}
			setSolving(false);
			setSolvePlan(null);
			setPhase(1);
			setSelections(startPositions);
			setCurrentPositions({ ...startPositions });
			setResolved(Array(count).fill(false));
			setMatrix(
				Array.from({ length: count }, (_, i) =>
					Array.from({ length: count }, (_, j) => (i === j ? 1 : 0)),
				),
			);
			setMovementPlan([]);
			setAutoApplyStep(null);
		}
	};

	const handleReset = () => {
		if (workerRef.current) {
			workerRef.current.terminate();
			workerRef.current = null;
		}
		setSolving(false);
		setPhase(1);
		setCount(7);
		setSelections({});
		setStartPositions({});
		setCurrentPositions({});
		setResolved(Array(7).fill(false));
		setMatrix(
			Array.from({ length: 7 }, (_, i) =>
				Array.from({ length: 7 }, (_, j) => (i === j ? 1 : 0)),
			),
		);
		setTestingDisc(0);
		setMovementPlan([]);
		setAutoApplyStep(null);
		setSolvePlan(null);
		setSolveStepIndex(0);
	};

	const handleNextDisc = () => {
		// Same as handleConfirmRelation: commit current selections, then advance
		handleConfirmRelation();
	};

	const handlePrevDisc = () => {
		if (testingDisc > 0) {
			setupRelationTest(currentPositions, testingDisc - 1);
		}
	};

	// Compute condensed solve steps (collapse consecutive same-disc moves, then merge independent steps)
	const condensedSteps = solvePlan
		? (() => {
				const steps = solvePlan.steps;
				if (!steps || steps.length === 0) return [];
				// Phase 1: collapse consecutive same-disc moves
				const collapsed = [];
				let i = 0;
				while (i < steps.length) {
					const disc = Object.keys(steps[i].move)[0];
					let lastIdx = i;
					while (
						lastIdx + 1 < steps.length &&
						Object.keys(steps[lastIdx + 1].move)[0] === disc
					) {
						lastIdx++;
					}
					const positionsBefore = { ...steps[i].positions };
					let positionsAfter;
					if (lastIdx + 1 < steps.length) {
						positionsAfter = { ...steps[lastIdx + 1].positions };
					} else {
						positionsAfter = {};
						for (let d = 0; d < count; d++) positionsAfter[d] = 4;
					}
					collapsed.push({
						discs: [parseInt(disc)],
						endPositions: { [parseInt(disc)]: steps[lastIdx].move[disc] },
						positionsBefore,
						positions: positionsAfter,
					});
					i = lastIdx + 1;
				}
				// Phase 2: merge consecutive steps with independent discs
				// Two steps can merge only if:
				// 1. Their discs are independent in the matrix
				// 2. Executing them in any order never puts any disc outside 1-7
				const canExecuteInAnyOrder = (prevStep, currStep, startPos) => {
					// Simulate: execute curr first, then prev
					// (original order prev→curr is already validated by solver)
					const simAfterCurr = { ...startPos };
					for (const d of currStep.discs) {
						// Apply disc d's full movement and its matrix effects
						const totalMove = currStep.endPositions[d] - startPos[d];
						simAfterCurr[d] = currStep.endPositions[d];
						for (let other = 0; other < count; other++) {
							if (other === d) continue;
							if (matrix[d][other] !== 0) {
								simAfterCurr[other] =
									(simAfterCurr[other] ?? startPos[other]) +
									matrix[d][other] * totalMove;
							}
						}
					}
					// Check bounds after curr
					for (let d = 0; d < count; d++) {
						if (simAfterCurr[d] < 1 || simAfterCurr[d] > 7) return false;
					}
					// Now apply prev on top
					const simFinal = { ...simAfterCurr };
					for (const d of prevStep.discs) {
						const totalMove = prevStep.endPositions[d] - startPos[d];
						simFinal[d] = prevStep.endPositions[d];
						for (let other = 0; other < count; other++) {
							if (other === d) continue;
							if (matrix[d][other] !== 0) {
								simFinal[other] =
									(simFinal[other] ?? simAfterCurr[other]) +
									matrix[d][other] * totalMove;
							}
						}
					}
					// Check bounds after both
					for (let d = 0; d < count; d++) {
						if (simFinal[d] < 1 || simFinal[d] > 7) return false;
					}
					return true;
				};

				const result = [collapsed[0]];
				for (let j = 1; j < collapsed.length; j++) {
					const prev = result[result.length - 1];
					const curr = collapsed[j];
					// Check if all discs in curr are independent of all discs in prev
					let canMerge = true;
					for (const d1 of prev.discs) {
						for (const d2 of curr.discs) {
							if (matrix[d1][d2] !== 0 || matrix[d2][d1] !== 0) {
								canMerge = false;
								break;
							}
						}
						if (!canMerge) break;
					}
					// Also verify any-order execution is safe
					if (canMerge) {
						canMerge = canExecuteInAnyOrder(prev, curr, prev.positionsBefore);
					}
					if (canMerge) {
						prev.discs = [...prev.discs, ...curr.discs];
						prev.endPositions = { ...prev.endPositions, ...curr.endPositions };
						prev.positions = curr.positions;
					} else {
						result.push(curr);
					}
				}
				return result;
			})()
		: [];

	const handleSolveStepForward = () => {
		if (solveStepIndex >= condensedSteps.length - 1) return;
		const nextIdx = solveStepIndex + 1;
		setSolveStepIndex(nextIdx);
		setSelections({ ...condensedSteps[nextIdx].positions });
	};

	const handleSolveStepBack = () => {
		if (solveStepIndex <= 0) return;
		const prevIdx = solveStepIndex - 1;
		setSolveStepIndex(prevIdx);
		setSelections({ ...condensedSteps[prevIdx].positions });
	};

	return (
		<div className="app">
			<div className="radio-groups">
				<div className="nav-buttons">
					<button className="home-btn" onClick={handleReset}>
						⌂
					</button>
					<button
						className="back-btn"
						onClick={handleBack}
						disabled={phase === 1}
					>
						←
					</button>
					<button
						className="forward-btn"
						onClick={handleForward}
						disabled={phase !== 1 || Object.keys(selections).length !== count}
					>
						→
					</button>
				</div>

				<div className="groups-container">
					<div className="groups-list">
						{Array.from({ length: count }, (_, groupIndex) => {
							const numOptions = 9;
							const isTested =
								(phase === 2 && groupIndex === testingDisc) ||
								(phase === 3 &&
									condensedSteps[solveStepIndex]?.discs.includes(groupIndex));
							return (
								<div key={groupIndex} className="group-row">
									<div className={`radio-group${isTested ? " tested" : ""}`}>
										<div className="options">
											{Array.from({ length: numOptions }, (_, optionIndex) => {
												const isEdge = optionIndex === 0 || optionIndex === 8;
												const isCenter = optionIndex === 4;
												const isLockedGroup =
													phase === 2 && groupIndex === testingDisc;
												const disabled =
													phase === 3 ||
													(phase === 1 && isEdge) ||
													isLockedGroup ||
													!!autoApplyStep ||
													(phase === 2 &&
														!isSelectableInPhase2(groupIndex, optionIndex));
												return (
													<label
														key={optionIndex}
														className={`radio-label${isEdge ? " edge" : ""}${isCenter ? " center" : ""}${disabled ? " disabled" : ""}`}
													>
														<input
															type="radio"
															name={`group-${groupIndex}`}
															value={optionIndex}
															checked={selections[groupIndex] === optionIndex}
															disabled={disabled}
															onChange={() =>
																handleOptionChange(groupIndex, optionIndex)
															}
														/>
													</label>
												);
											})}
										</div>
									</div>
									{phase === 1 ? (
										<button
											className="row-action-btn"
											onClick={() => removeGroup(groupIndex)}
											disabled={count <= 1}
										>
											−
										</button>
									) : (
										<button
											className="row-action-btn"
											onClick={() => handleUndoSelection(groupIndex)}
											disabled={
												phase === 3 ||
												selections[groupIndex] === undefined ||
												(phase === 2 && groupIndex === testingDisc)
											}
										>
											×
										</button>
									)}
								</div>
							);
						})}
					</div>
				</div>

				{phase === 1 && (
					<button className="plus-btn" onClick={addGroup}>
						+
					</button>
				)}

				{/* Solving progress */}
				{phase === 3 && solving && (
					<div className="solve-plan">
						<div className="progress-bar">
							<div className="progress-bar-fill" />
						</div>
					</div>
				)}

				{/* Disc/step navigation (phase 2 and phase 3) */}
				<div
					className={`phase-indicator${phase !== 2 && !(phase === 3 && solvePlan) ? " hidden" : ""}`}
				>
					{phase === 2 && (
						<button className="refresh-btn" onClick={handleRefresh}>
							↻
						</button>
					)}
					{phase === 3 && solvePlan && (
						<button
							onClick={handleSolveStepBack}
							disabled={solveStepIndex <= 0}
						>
							◀
						</button>
					)}
					<span className="disc-progress">
						{phase === 2 &&
							Array.from({ length: count }, (_, i) => (
								<span
									key={i}
									className={`progress-dot${i === testingDisc ? " active" : ""}${resolved[i] ? " done" : ""}`}
								/>
							))}
						{phase === 3 &&
							solvePlan &&
							condensedSteps.map((_, i) => (
								<span
									key={i}
									className={`progress-dot${i < solveStepIndex ? " done" : ""}${i === solveStepIndex ? " active" : ""}`}
								/>
							))}
					</span>
					{phase === 2 && <button onClick={handleNextDisc}>▶</button>}
					{phase === 3 && solvePlan && (
						<button
							onClick={handleSolveStepForward}
							disabled={solveStepIndex >= condensedSteps.length - 1}
						>
							▶
						</button>
					)}
				</div>

				{showDebug && (
					<details className="debug-panel">
						<summary>Debug</summary>
						<p>
							<strong>count:</strong> {count}
						</p>
						<p>
							<strong>phase:</strong> {phase}
							{phase === 2 && ` (disc ${testingDisc + 1})`}
						</p>
						<p>
							<strong>selections:</strong> {JSON.stringify(selections)}
						</p>
						<p>
							<strong>resolved ({resolved.length}):</strong> [
							{resolved.map((b) => String(b)).join(", ")}]
						</p>
						<p>
							<strong>startPositions:</strong> {JSON.stringify(startPositions)}
						</p>
						<p>
							<strong>currentPositions:</strong>{" "}
							{JSON.stringify(currentPositions)}
						</p>
						<p>
							<strong>matrix:</strong>
						</p>
						<pre>
							{matrix
								.map(
									(row, i) =>
										`${resolved[i] ? "✓" : "✗"} ${i}: ${row.join(", ")}`,
								)
								.join("\n")}
						</pre>
						<p>
							<strong>movementPlan:</strong>
						</p>
						<pre>
							{movementPlan
								.map((step, idx) => {
									const move = step.move || step;
									return `${idx}: ${JSON.stringify(move)}`;
								})
								.join("\n")}
						</pre>
						<p>
							<strong>positionHistory:</strong>
						</p>
						<pre>
							{movementPlan
								.map((step, idx) => {
									const pos = step.positions;
									return pos ? `${idx}: ${JSON.stringify(pos)}` : `${idx}: ?`;
								})
								.join("\n")}
						</pre>
						{solvePlan && (
							<>
								<p>
									<strong>
										rawSolution ({solvePlan.steps.length} steps, cost{" "}
										{solvePlan.cost}):
									</strong>
								</p>
								<pre>
									{solvePlan.steps
										.map(
											(step, idx) =>
												`${idx}: move ${JSON.stringify(step.move)} | pos ${JSON.stringify(step.positions)}`,
										)
										.join("\n")}
								</pre>
								<p>
									<strong>condensedSteps ({condensedSteps.length}):</strong>
								</p>
								<pre>
									{condensedSteps
										.map(
											(step, idx) =>
												`${idx}: discs [${step.discs.join(",")}] → ${JSON.stringify(step.positions)}`,
										)
										.join("\n")}
								</pre>
							</>
						)}
					</details>
				)}
			</div>
		</div>
	);
}

export default App;
