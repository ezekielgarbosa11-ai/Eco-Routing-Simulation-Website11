// FORMULA FOR EDGE DELAY - FORMULA 3 (congestion-aware, queueing-style delay)
function calculateDelay(distance, v, utilization) {
  const cappedUtil = Math.min(utilization, 0.95); // cap prevents divide-by-zero at full congestion
  return distance / v + deltaT / (1 - cappedUtil);
}

// POWER MODEL - baseline + congestion-dependent + small distance adjustment
function calculatePower(basePower, dynamicPower, utilization, distance, distanceFactor) {
  return basePower + dynamicPower * utilization + distance * distanceFactor;
}

// FORMULA FOR CARBON COST - FORMULA 4 (unit-corrected: joules -> kWh -> grams)
function calculateCarbon(power, deltaT, cef) {
  const energyJoules = power * deltaT;
  const energyKWh = energyJoules / 3600000;
  const carbonKg = energyKWh * cef;
  return carbonKg * 1000; // convert kg to grams
}

const basePower = 52;           // watts, Cisco Catalyst 1300 baseline (per datasheet)
const dynamicPower = 5;         // watts, extra draw when a link is fully congested
const distanceFactor = 0.00001; // watts per meter, small realism adjustment
const cef = 0.672;              // kg CO2 per kWh, Philippines grid average
const packetSize = 1500 * 8;
const bandwidth = 3.5 * 10 ** 6; // DepEd Order No. 46, s. 2011
const deltaT = packetSize / bandwidth;
const v = 2.0 * 10 ** 8;

const CARBON_RATIOS = [0.9, 0.7, 0.5]; // fixed budget levels to test

let rawEdges = [];
let scenarioResults = [];
let activeScenarioIndex = 0;

function addEdge() {
  const from = document.getElementById("fromInput").value.trim();
  const to = document.getElementById("toInput").value.trim();
  const distance = parseFloat(document.getElementById("distInput").value);
  const utilInputVal = document.getElementById("utilInput").value;
  const utilization = utilInputVal === "" ? 0.5 : parseFloat(utilInputVal);

  if (!from || !to || isNaN(distance) || isNaN(utilization)) {
    alert("Please fill in from, to, and a valid distance (congestion is optional).");
    return;
  }

  rawEdges.push({ from, to, distance, utilization });
  renderEdgeList();
  drawGraph();

  document.getElementById("fromInput").value = "";
  document.getElementById("toInput").value = "";
  document.getElementById("distInput").value = "";
  document.getElementById("utilInput").value = "";
}

function congestionColor(utilization) {
  const idle = [56, 189, 248];
  const busy = [245, 165, 36];
  const t = Math.max(0, Math.min(1, utilization));
  const r = Math.round(idle[0] + (busy[0] - idle[0]) * t);
  const g = Math.round(idle[1] + (busy[1] - idle[1]) * t);
  const b = Math.round(idle[2] + (busy[2] - idle[2]) * t);
  return `rgb(${r},${g},${b})`;
}

function renderEdgeList() {
  const list = document.getElementById("edgeList");
  if (rawEdges.length === 0) {
    list.innerHTML = `<p class="empty-note">No links yet — add one above to start building the network.</p>`;
    return;
  }
  list.innerHTML = rawEdges
    .map((e) => `<div class="edge-row"><span class="dot" style="background:${congestionColor(e.utilization)}"></span>${e.from} &rarr; ${e.to} &middot; ${e.distance}m &middot; congestion ${e.utilization}</div>`)
    .join("");
}

function buildAdjacencyList(edges) {
  const graph = {};
  for (const edge of edges) {
    if (!graph[edge.from]) graph[edge.from] = [];
    graph[edge.from].push(edge);
  }
  return graph;
}

function findAllPaths(graph, source, destination, path = [], visited = new Set()) {
  visited.add(source);
  path.push(source);
  let allPaths = [];
  if (source === destination) {
    allPaths.push([...path]);
  } else {
    const neighbors = graph[source] || [];
    for (const edge of neighbors) {
      if (!visited.has(edge.to)) {
        allPaths = allPaths.concat(findAllPaths(graph, edge.to, destination, path, visited));
      }
    }
  }
  path.pop();
  visited.delete(source);
  return allPaths;
}

function nodesToEdgePath(nodePath, graph) {
  const edgePath = [];
  for (let i = 0; i < nodePath.length - 1; i++) {
    edgePath.push(graph[nodePath[i]].find((e) => e.to === nodePath[i + 1]));
  }
  return edgePath;
}

function findBestPath(candidatePaths, carbonBudget) {
  let bestPath = null, bestDelay = Infinity, bestCarbon = null;
  for (const path of candidatePaths) {
    let totalDelay = 0, totalCarbon = 0;
    for (const edge of path) {
      totalDelay += edge.edgeDelay;
      totalCarbon += edge.carbonCost;
    }
    if (totalCarbon <= carbonBudget && totalDelay < bestDelay) {
      bestDelay = totalDelay; bestCarbon = totalCarbon; bestPath = path;
    }
  }
  if (bestPath === null) return { feasible: false };
  return { feasible: true, bestPath, bestDelay, bestCarbon };
}

function runRCSPP() {
  const source = document.getElementById("sourceInput").value.trim();
  const destination = document.getElementById("destInput").value.trim();
  const output = document.getElementById("output");
  const scenarios = document.getElementById("scenarios");

  if (rawEdges.length === 0) {
    output.innerHTML = `<p class="empty-note">Add some links first.</p>`;
    scenarios.innerHTML = "";
    return;
  }

  const edgeData = rawEdges.map((edge) => {
    const d_ij = calculateDelay(edge.distance, v, edge.utilization);
    const p_ij = calculatePower(basePower, dynamicPower, edge.utilization, edge.distance, distanceFactor);
    const c_ij = calculateCarbon(p_ij, deltaT, cef);
    return { ...edge, edgeDelay: d_ij, carbonCost: c_ij };
  });

  const graph = buildAdjacencyList(edgeData);
  const nodePaths = findAllPaths(graph, source, destination);

  if (nodePaths.length === 0) {
    output.innerHTML = `<p class="empty-note">No path exists from ${source} to ${destination}.</p>`;
    scenarios.innerHTML = "";
    drawGraph();
    return;
  }

  const candidatePaths = nodePaths.map((np) => nodesToEdgePath(np, graph));
  const unconstrained = findBestPath(candidatePaths, Infinity);

  scenarioResults = [{ label: "Fastest", ratio: null, result: unconstrained }];
  CARBON_RATIOS.forEach((ratio) => {
    const budget = unconstrained.bestCarbon * ratio;
    const eco = findBestPath(candidatePaths, budget);
    scenarioResults.push({ label: `Budget ${ratio}`, ratio, result: eco, budget });
  });

  activeScenarioIndex = 0;
  renderScenarioButtons();
  renderScenarioResult(unconstrained, null);
  drawGraph(unconstrained.bestPath);
}

function renderScenarioButtons() {
  const scenarios = document.getElementById("scenarios");
  scenarios.innerHTML = scenarioResults
    .map((s, i) => `<button class="scenario-btn ${i === activeScenarioIndex ? "active" : ""} ${!s.result.feasible ? "infeasible" : ""}" onclick="selectScenario(${i})">${s.label}</button>`)
    .join("");
}

function selectScenario(i) {
  activeScenarioIndex = i;
  renderScenarioButtons();
  const s = scenarioResults[i];
  renderScenarioResult(s.result, s.ratio, s.budget);
  drawGraph(s.result.feasible ? s.result.bestPath : []);
}

function renderScenarioResult(result, ratio, budget) {
  const output = document.getElementById("output");
  const unconstrained = scenarioResults[0].result;

  if (!result.feasible) {
    output.innerHTML = `<p class="empty-note">No feasible route at this carbon budget${budget ? ` (${budget.toExponential(3)} g)` : ""}.</p>`;
    return;
  }

  const route = result.bestPath.map(e => `${e.from} &rarr; ${e.to}`).join(", ");
  let tradeoffLine = "";
  if (ratio !== null) {
    const percentCarbonSaved = ((unconstrained.bestCarbon - result.bestCarbon) / unconstrained.bestCarbon) * 100;
    const percentLatencyIncrease = ((result.bestDelay - unconstrained.bestDelay) / unconstrained.bestDelay) * 100;
    const tradeoffRatio = percentLatencyIncrease === 0 ? "N/A" : (percentCarbonSaved / percentLatencyIncrease).toFixed(3);
    tradeoffLine = `<div class="row"><span class="label">Trade-off ratio</span><span>${tradeoffRatio}</span></div>`;
  }

  output.innerHTML = `
    <div class="route">${route}</div>
    <div class="row"><span class="label">Delay</span><span>${result.bestDelay.toFixed(7)} s</span></div>
    <div class="row"><span class="label">Carbon</span><span>${result.bestCarbon.toExponential(4)} g</span></div>  
    ${tradeoffLine}
  `;
}

function drawGraph(highlightPath) {
  const svg = document.getElementById("graphSvg");
  svg.innerHTML = "";

  const nodeNames = [...new Set(rawEdges.flatMap(e => [e.from, e.to]))];
  if (nodeNames.length === 0) return;

  const cx = 300, cy = 210, radius = Math.min(160, 60 + nodeNames.length * 10);
  const positions = {};
  nodeNames.forEach((name, i) => {
    const angle = (i / nodeNames.length) * 2 * Math.PI - Math.PI / 2;
    positions[name] = {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });

  const highlightSet = new Set((highlightPath || []).map(e => `${e.from}->${e.to}`));

  const svgns = "http://www.w3.org/2000/svg";

  const defs = document.createElementNS(svgns, "defs");
  defs.innerHTML = `
    <marker id="arrowIdle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M1 1L9 5L1 9" fill="none" stroke-width="1.6" />
    </marker>`;
  svg.appendChild(defs);

  rawEdges.forEach((edge) => {
    const p1 = positions[edge.from], p2 = positions[edge.to];
    const key = `${edge.from}->${edge.to}`;
    const isSelected = highlightSet.has(key);
    const color = isSelected ? "#34d399" : congestionColor(edge.utilization);

    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nodeR = 26;
    const x1 = p1.x + (dx / len) * nodeR;
    const y1 = p1.y + (dy / len) * nodeR;
    const x2 = p2.x - (dx / len) * (nodeR + 6);
    const y2 = p2.y - (dy / len) * (nodeR + 6);

    const line = document.createElementNS(svgns, "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", isSelected ? 3.5 : 2);
    line.setAttribute("marker-end", "url(#arrowIdle)");
    line.style.stroke = color;
    svg.appendChild(line);

    const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
    const label = document.createElementNS(svgns, "text");
    label.setAttribute("x", midX);
    label.setAttribute("y", midY - 6);
    label.setAttribute("fill", isSelected ? "#34d399" : "#7f95a6");
    label.setAttribute("font-size", "10");
    label.setAttribute("font-family", "IBM Plex Mono, monospace");
    label.setAttribute("text-anchor", "middle");
    label.textContent = `${edge.distance}m`;
    svg.appendChild(label);
  });

  nodeNames.forEach((name) => {
    const p = positions[name];
    const circle = document.createElementNS(svgns, "circle");
    circle.setAttribute("cx", p.x);
    circle.setAttribute("cy", p.y);
    circle.setAttribute("r", 24);
    circle.setAttribute("fill", "#141f28");
    circle.setAttribute("stroke", "#38bdf8");
    circle.setAttribute("stroke-width", "1.5");
    svg.appendChild(circle);

    const text = document.createElementNS(svgns, "text");
    text.setAttribute("x", p.x);
    text.setAttribute("y", p.y + 4);
    text.setAttribute("fill", "#dce6ee");
    text.setAttribute("font-size", "10.5");
    text.setAttribute("font-family", "Space Grotesk, sans-serif");
    text.setAttribute("font-weight", "600");
    text.setAttribute("text-anchor", "middle");
    text.textContent = name.length > 10 ? name.slice(0, 9) + "…" : name;
    svg.appendChild(text);
  });
}

renderEdgeList();
drawGraph();
