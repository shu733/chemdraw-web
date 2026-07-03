// ========== State ==========
const ELEMENTS = ['C','H','N','O','S','P','F','Cl','Br','I'];
const ATOM_COLORS = {
  C:'#222', H:'#555', N:'#2471a3', O:'#c0392b', S:'#d4ac0d',
  P:'#884ea0', F:'#1abc9c', Cl:'#27ae60', Br:'#a04000', I:'#6c3483',
  default:'#222'
};
const CANVAS_BG = '#f5f5f0';
const GRID = 40;

let state = {
  atoms: [],   // {id, x, y, symbol, charge, implicitH}
  bonds: [],   // {id, a, b, order}
  nextId: 1,
  tool: 'draw',
  selectedElement: 'C',
  bondOrder: 1,
  selected: new Set(),
  history: [],
  skeletalMode: false,
  bwMode: false,        // 白黒モード
};

let drag = null;  // {type, atomId, startX, startY, curX, curY}
let hoveredAtom = null;
let canvas, ctx;

// ========== Init ==========
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('chem-canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  buildElementGrid();

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('contextmenu', onRightClick);

  window.addEventListener('keydown', onKeyDown);

  checkBackend();
  render();
});

function resizeCanvas() {
  const container = document.getElementById('canvas-container');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  render();
}

function buildElementGrid() {
  const grid = document.getElementById('element-grid');
  ELEMENTS.forEach(el => {
    const btn = document.createElement('button');
    btn.className = 'elem-btn' + (el === 'C' ? ' active' : '');
    btn.textContent = el;
    btn.onclick = () => selectElement(el);
    btn.id = 'elem-' + el;
    grid.appendChild(btn);
  });
}

// ========== Tool management ==========
function setTool(t) {
  state.tool = t;
  ['draw','select','erase'].forEach(x => {
    document.getElementById('btn-'+x).classList.toggle('active', x === t);
  });
  canvas.style.cursor = t === 'select' ? 'default' : t === 'erase' ? 'not-allowed' : 'crosshair';
}

function selectElement(el) {
  state.selectedElement = el;
  document.querySelectorAll('.elem-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('elem-' + el).classList.add('active');
  if (state.tool !== 'draw') setTool('draw');
}

function setBond(order) {
  state.bondOrder = order;
  [1,2,3].forEach(o => {
    document.getElementById('bond-'+['single','double','triple'][o-1]).classList.toggle('active', o === order);
  });
}

function toggleSkeletal() {
  state.skeletalMode = !state.skeletalMode;
  document.getElementById('btn-skeletal').classList.toggle('active', state.skeletalMode);
  if (state.skeletalMode) selectElement('C');
  render();
}

function toggleBW() {
  state.bwMode = !state.bwMode;
  document.getElementById('btn-bw').classList.toggle('active', state.bwMode);
  render();
}

// ========== History ==========
function saveHistory() {
  state.history.push(JSON.stringify({atoms: state.atoms, bonds: state.bonds, nextId: state.nextId}));
  if (state.history.length > 50) state.history.shift();
}

function undo() {
  if (!state.history.length) return;
  const prev = JSON.parse(state.history.pop());
  state.atoms = prev.atoms;
  state.bonds = prev.bonds;
  state.nextId = prev.nextId;
  updateInfoBar();
  render();
}

// ========== Geometry helpers ==========
function dist(x1,y1,x2,y2) { return Math.sqrt((x2-x1)**2+(y2-y1)**2); }

function findAtomAt(x, y, radius = 18) {
  let best = null, bestD = radius;
  for (const a of state.atoms) {
    const d = dist(x, y, a.x, a.y);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

function snapAngle(x1, y1, x2, y2) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const snapped = Math.round(angle / (Math.PI / 6)) * (Math.PI / 6);
  const d = Math.max(GRID, dist(x1, y1, x2, y2));
  return { x: x1 + Math.cos(snapped) * d, y: y1 + Math.sin(snapped) * d };
}

function findBondAt(x, y, tol = 8) {
  for (const b of state.bonds) {
    const a1 = getAtom(b.a), a2 = getAtom(b.b);
    if (!a1 || !a2) continue;
    const dx = a2.x - a1.x, dy = a2.y - a1.y;
    const len = Math.sqrt(dx*dx+dy*dy);
    if (len < 1) continue;
    const t = ((x-a1.x)*dx + (y-a1.y)*dy) / (len*len);
    if (t < 0 || t > 1) continue;
    const px = a1.x + t*dx, py = a1.y + t*dy;
    if (dist(x,y,px,py) < tol) return b;
  }
  return null;
}

function getAtom(id) { return state.atoms.find(a => a.id === id); }
function getBond(a, b) { return state.bonds.find(bd => (bd.a===a&&bd.b===b)||(bd.a===b&&bd.b===a)); }

// ========== Mouse events ==========
function onMouseDown(e) {
  if (e.button !== 0) return;
  const {x, y} = canvasPos(e);
  saveHistory();

  if (state.tool === 'erase') {
    const a = findAtomAt(x, y);
    if (a) { removeAtom(a.id); updateInfoBar(); render(); return; }
    const b = findBondAt(x, y);
    if (b) { removeBond(b.id); render(); return; }
    return;
  }

  if (state.tool === 'select') {
    const a = findAtomAt(x, y);
    if (a) {
      drag = {type:'move', atomId: a.id, startX: x, startY: y, origX: a.x, origY: a.y};
    }
    return;
  }

  // draw tool
  const a = findAtomAt(x, y);
  if (a) {
    drag = {type:'bond', atomId: a.id, startX: a.x, startY: a.y, curX: x, curY: y};
  } else {
    // place atom
    const newAtom = {id: state.nextId++, x, y, symbol: state.selectedElement, charge: 0};
    state.atoms.push(newAtom);
    drag = {type:'bond', atomId: newAtom.id, startX: x, startY: y, curX: x, curY: y};
    updateInfoBar();
  }
  render();
}

function onMouseMove(e) {
  const {x, y} = canvasPos(e);
  document.getElementById('coords').textContent = `x:${Math.round(x)} y:${Math.round(y)}`;

  hoveredAtom = findAtomAt(x, y);

  if (!drag) { render(); return; }

  if (drag.type === 'move') {
    const a = getAtom(drag.atomId);
    if (a) { a.x = x; a.y = y; }
  } else if (drag.type === 'bond') {
    const snapped = snapAngle(drag.startX, drag.startY, x, y);
    drag.curX = snapped.x;
    drag.curY = snapped.y;
  }
  render();
}

function onMouseUp(e) {
  if (!drag) return;
  const {x, y} = canvasPos(e);

  if (drag.type === 'bond') {
    const src = getAtom(drag.atomId);
    if (!src) { drag = null; return; }

    let target = findAtomAt(drag.curX, drag.curY, 20);

    if (target && target.id !== src.id) {
      // connect to existing atom
      const existing = getBond(src.id, target.id);
      if (existing) {
        // cycle bond order
        existing.order = existing.order >= 3 ? 1 : existing.order + 1;
      } else {
        state.bonds.push({id: state.nextId++, a: src.id, b: target.id, order: state.bondOrder});
      }
    } else if (dist(drag.startX, drag.startY, drag.curX, drag.curY) > 15) {
      // create new atom at end
      const snapped = snapAngle(drag.startX, drag.startY, x, y);
      const newAtom = {id: state.nextId++, x: snapped.x, y: snapped.y, symbol: state.selectedElement, charge: 0};
      state.atoms.push(newAtom);
      state.bonds.push({id: state.nextId++, a: src.id, b: newAtom.id, order: state.bondOrder});
    }
    updateInfoBar();
  }

  drag = null;
  render();
  localSMILES();
}

function onRightClick(e) {
  e.preventDefault();
  const {x, y} = canvasPos(e);
  const a = findAtomAt(x, y);
  if (a) {
    saveHistory();
    removeAtom(a.id);
    updateInfoBar();
    render();
  }
}

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return {x: e.clientX - r.left, y: e.clientY - r.top};
}

// ========== Atom/bond removal ==========
function removeAtom(id) {
  state.atoms = state.atoms.filter(a => a.id !== id);
  state.bonds = state.bonds.filter(b => b.a !== id && b.b !== id);
}

function removeBond(id) {
  state.bonds = state.bonds.filter(b => b.id !== id);
}

// ========== Templates ==========
function insertTemplate(name) {
  saveHistory();
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const r = GRID * 1.1;

  if (name === 'benzene') {
    const n = 6;
    const ids = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * 2 * Math.PI - Math.PI/2;
      const atom = {id: state.nextId++, x: cx + Math.cos(angle)*r, y: cy + Math.sin(angle)*r, symbol:'C', charge:0};
      state.atoms.push(atom);
      ids.push(atom.id);
    }
    for (let i = 0; i < n; i++) {
      state.bonds.push({id: state.nextId++, a: ids[i], b: ids[(i+1)%n], order: i%2===0?2:1});
    }
  } else if (name === 'cyclohexane') {
    const n = 6;
    const ids = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * 2 * Math.PI - Math.PI/2;
      const atom = {id: state.nextId++, x: cx + Math.cos(angle)*r, y: cy + Math.sin(angle)*r, symbol:'C', charge:0};
      state.atoms.push(atom);
      ids.push(atom.id);
    }
    for (let i = 0; i < n; i++) {
      state.bonds.push({id: state.nextId++, a: ids[i], b: ids[(i+1)%n], order: 1});
    }
  } else if (name === 'cyclopentane') {
    const n = 5;
    const ids = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * 2 * Math.PI - Math.PI/2;
      const atom = {id: state.nextId++, x: cx + Math.cos(angle)*r, y: cy + Math.sin(angle)*r, symbol:'C', charge:0};
      state.atoms.push(atom);
      ids.push(atom.id);
    }
    for (let i = 0; i < n; i++) {
      state.bonds.push({id: state.nextId++, a: ids[i], b: ids[(i+1)%n], order: 1});
    }
  }

  updateInfoBar();
  render();
  localSMILES();
}

// ========== Keyboard ==========
function onKeyDown(e) {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'd' || e.key === 'D') setTool('draw');
  if (e.key === 's' || e.key === 'S') setTool('select');
  if (e.key === 'e' || e.key === 'E') setTool('erase');
  if (e.key === 'k' || e.key === 'K') toggleSkeletal();
  if (e.key === 'b' || e.key === 'B') toggleBW();
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // erase hovered atom
    if (hoveredAtom) { saveHistory(); removeAtom(hoveredAtom.id); updateInfoBar(); render(); }
  }
}

// ========== Render ==========
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = CANVAS_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // draw grid dots (subtle)
  ctx.fillStyle = '#ccc';
  for (let x = GRID; x < canvas.width; x += GRID) {
    for (let y = GRID; y < canvas.height; y += GRID) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI*2);
      ctx.fill();
    }
  }

  // bonds
  for (const b of state.bonds) {
    const a1 = getAtom(b.a), a2 = getAtom(b.b);
    if (!a1 || !a2) continue;
    drawBond(a1, a2, b.order);
  }

  // drag preview line
  if (drag && drag.type === 'bond') {
    ctx.save();
    ctx.strokeStyle = '#2874a6';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(drag.startX, drag.startY);
    ctx.lineTo(drag.curX, drag.curY);
    ctx.stroke();
    ctx.restore();
  }

  // atoms
  for (const a of state.atoms) {
    drawAtom(a);
  }
}

function atomNeedsLabel(a) {
  // 骨格式モードでは炭素ラベルを非表示
  if (state.skeletalMode && a.symbol === 'C') return false;
  return true;
}

function drawBond(a1, a2, order) {
  const dx = a2.x - a1.x, dy = a2.y - a1.y;
  const len = Math.sqrt(dx*dx+dy*dy);
  if (len < 1) return;
  const ux = dx/len, uy = dy/len;
  const px = -uy, py = ux; // perpendicular

  // ラベルのある原子だけ手前で止める（隙間を小さく）
  const r1 = atomNeedsLabel(a1) ? 11 : 0;
  const r2 = atomNeedsLabel(a2) ? 11 : 0;
  const x1 = a1.x + ux*r1, y1 = a1.y + uy*r1;
  const x2 = a2.x - ux*r2, y2 = a2.y - uy*r2;

  ctx.strokeStyle = state.bwMode ? '#000' : '#333';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  if (order === 1) {
    drawLine(x1, y1, x2, y2);
  } else if (order === 2) {
    const off = 3;
    drawLine(x1+px*off, y1+py*off, x2+px*off, y2+py*off);
    drawLine(x1-px*off, y1-py*off, x2-px*off, y2-py*off);
  } else if (order === 3) {
    const off = 4;
    drawLine(x1, y1, x2, y2);
    drawLine(x1+px*off, y1+py*off, x2+px*off, y2+py*off);
    drawLine(x1-px*off, y1-py*off, x2-px*off, y2-py*off);
  }
}

function drawLine(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawAtom(a) {
  const isHovered = hoveredAtom && hoveredAtom.id === a.id;
  const showLabel = atomNeedsLabel(a);

  if (showLabel) {
    const fontSize = a.symbol.length > 1 ? 12 : 15;
    ctx.font = `bold ${fontSize}px sans-serif`;
    const tw = ctx.measureText(a.symbol).width;
    const pad = 5;
    const rw = tw / 2 + pad, rh = fontSize / 2 + pad;

    ctx.fillStyle = isHovered ? '#d6eaf8' : CANVAS_BG;
    ctx.fillRect(a.x - rw, a.y - rh, rw * 2, rh * 2);

    if (isHovered) {
      ctx.strokeStyle = '#2874a6';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x - rw, a.y - rh, rw * 2, rh * 2);
    }

    const color = state.bwMode ? '#000' : (ATOM_COLORS[a.symbol] || ATOM_COLORS.default);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(a.symbol, a.x, a.y);
  } else {
    // 骨格式モードの炭素
    // 結合が1本以下（孤立・末端）は小さな点を表示して存在を示す
    const bondCount = state.bonds.filter(b => b.a === a.id || b.b === a.id).length;
    if (bondCount === 0) {
      // 孤立原子：点を表示
      ctx.beginPath();
      ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = state.bwMode ? '#000' : '#555';
      ctx.fill();
    }
    if (isHovered) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(40, 116, 166, 0.2)';
      ctx.fill();
      ctx.strokeStyle = '#2874a6';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// ========== Info bar ==========
function updateInfoBar() {
  document.getElementById('atom-count').textContent = state.atoms.length;
  document.getElementById('bond-count').textContent = state.bonds.length;
}

// ========== SMILES (local simple version) ==========
function localSMILES() {
  if (!state.atoms.length) { document.getElementById('smiles-display').textContent = '-'; return; }
  // Simple DFS SMILES — not fully valid but useful for display
  const adj = {};
  state.atoms.forEach(a => adj[a.id] = []);
  state.bonds.forEach(b => {
    adj[b.a].push({to: b.b, order: b.order});
    adj[b.b].push({to: b.a, order: b.order});
  });

  const visited = new Set();
  const bondChar = o => o === 2 ? '=' : o === 3 ? '#' : '';

  function dfs(id, fromId) {
    visited.add(id);
    const a = getAtom(id);
    let s = a.symbol;
    const neighbors = adj[id].filter(n => !visited.has(n.to));
    const ring = adj[id].filter(n => visited.has(n.to) && n.to !== fromId);
    ring.forEach(n => s += bondChar(n.order) + '1'); // simplified ring
    neighbors.forEach((n, i) => {
      const sub = dfs(n.to, id);
      if (i < neighbors.length - 1) s += `(${bondChar(n.order)}${sub})`;
      else s += bondChar(n.order) + sub;
    });
    return s;
  }

  let smiles = '';
  for (const a of state.atoms) {
    if (!visited.has(a.id)) {
      if (smiles) smiles += '.';
      smiles += dfs(a.id, null);
    }
  }
  document.getElementById('smiles-display').textContent = smiles;
}

// ========== Backend ==========
const API = 'http://localhost:8000';

async function checkBackend() {
  try {
    const r = await fetch(API + '/health', {signal: AbortSignal.timeout(2000)});
    if (r.ok) {
      document.getElementById('backend-status').textContent = '接続済み';
      document.getElementById('backend-status').style.color = '#2ecc71';
    }
  } catch {
    document.getElementById('backend-status').textContent = '未接続';
    document.getElementById('backend-status').style.color = '#e74c3c';
  }
}

async function callBackend() {
  const payload = {atoms: state.atoms, bonds: state.bonds};
  try {
    const r = await fetch(API + '/smiles', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.smiles) {
      document.getElementById('smiles-display').textContent = data.smiles;
      alert('SMILES: ' + data.smiles);
    } else {
      alert('エラー: ' + (data.error || '不明'));
    }
  } catch {
    alert('バックエンドに接続できません。\npython backend/main.py を起動してください。');
  }
}

// ========== MOL Import ==========
function importMOL(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      parseMOL(e.target.result);
    } catch(err) {
      alert('MOLファイルの読み込みに失敗しました:\n' + err.message);
    }
    // 同じファイルを再度選べるようにリセット
    input.value = '';
  };
  reader.readAsText(file);
}

function parseMOL(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // ヘッダー3行をスキップ
  // 4行目: counts line  "aaabbblllfffcccsssxxxrrrpppiiimmmvvvvvv"
  const countsLine = lines[3] || '';
  const numAtoms = parseInt(countsLine.substring(0, 3).trim(), 10);
  const numBonds = parseInt(countsLine.substring(3, 6).trim(), 10);

  if (isNaN(numAtoms) || isNaN(numBonds)) throw new Error('counts lineが読めません');

  // MOL座標をキャンバス座標へスケーリング
  const molAtoms = [];
  for (let i = 0; i < numAtoms; i++) {
    const line = lines[4 + i] || '';
    const x  = parseFloat(line.substring(0, 10).trim());
    const y  = parseFloat(line.substring(10, 20).trim());
    const sym = line.substring(31, 34).trim();
    if (!sym) throw new Error(`原子行 ${i+1} が読めません`);
    molAtoms.push({x, y, symbol: sym});
  }

  // 座標をキャンバスに合わせてスケーリング
  const xs = molAtoms.map(a => a.x), ys = molAtoms.map(a => a.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const molW = maxX - minX || 1, molH = maxY - minY || 1;
  const padX = canvas.width  * 0.1;
  const padY = canvas.height * 0.1;
  const scaleX = (canvas.width  - padX * 2) / molW;
  const scaleY = (canvas.height - padY * 2) / molH;
  const scale  = Math.min(scaleX, scaleY, 80); // 最大80px/Å
  const offX = padX + (canvas.width  - padX*2 - molW * scale) / 2;
  const offY = padY + (canvas.height - padY*2 - molH * scale) / 2;

  saveHistory();
  state.atoms = [];
  state.bonds = [];

  const idMap = {}; // mol index (1-based) → state id
  molAtoms.forEach((ma, i) => {
    const id = state.nextId++;
    idMap[i + 1] = id;
    state.atoms.push({
      id,
      x: offX + (ma.x - minX) * scale,
      y: offY + (maxY - ma.y) * scale, // Y反転（MOLはY上向き）
      symbol: ma.symbol,
      charge: 0,
    });
  });

  // 結合ブロック
  const bondTypeMap = {1:1, 2:2, 3:3, 4:1}; // 4=芳香族→単結合で代用
  for (let i = 0; i < numBonds; i++) {
    const line = lines[4 + numAtoms + i] || '';
    const a1  = parseInt(line.substring(0, 3).trim(), 10);
    const a2  = parseInt(line.substring(3, 6).trim(), 10);
    const type = parseInt(line.substring(6, 9).trim(), 10);
    if (idMap[a1] && idMap[a2]) {
      state.bonds.push({
        id: state.nextId++,
        a: idMap[a1],
        b: idMap[a2],
        order: bondTypeMap[type] || 1,
      });
    }
  }

  updateInfoBar();
  render();
  localSMILES();
}

// ========== Export ==========
function exportSVG() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', canvas.width);
  svg.setAttribute('height', canvas.height);
  svg.setAttribute('xmlns', svgNS);

  // background
  const bg = document.createElementNS(svgNS, 'rect');
  bg.setAttribute('width', canvas.width); bg.setAttribute('height', canvas.height); bg.setAttribute('fill', CANVAS_BG);
  svg.appendChild(bg);

  // bonds
  for (const b of state.bonds) {
    const a1 = getAtom(b.a), a2 = getAtom(b.b);
    if (!a1 || !a2) continue;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', a1.x); line.setAttribute('y1', a1.y);
    line.setAttribute('x2', a2.x); line.setAttribute('y2', a2.y);
    line.setAttribute('stroke', '#333'); line.setAttribute('stroke-width', '2');
    svg.appendChild(line);
  }

  // atoms
  for (const a of state.atoms) {
    const t = document.createElementNS(svgNS, 'text');
    t.setAttribute('x', a.x); t.setAttribute('y', a.y);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('font-family', 'sans-serif'); t.setAttribute('font-weight', 'bold');
    t.setAttribute('font-size', '15'); t.setAttribute('fill', ATOM_COLORS[a.symbol] || '#222');
    t.textContent = a.symbol;
    svg.appendChild(t);
  }

  const blob = new Blob([svg.outerHTML], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'molecule.svg'; a.click();
  URL.revokeObjectURL(url);
}

function clearCanvas() {
  saveHistory();
  state.atoms = [];
  state.bonds = [];
  updateInfoBar();
  document.getElementById('smiles-display').textContent = '-';
  render();
}
