'use strict';
// ============================================================
// ChemDraw Web v2 — Natural skeletal rendering, stereo bonds,
// zoom/pan, lasso, charges, biochemical templates
// ============================================================

// ─── Constants ────────────────────────────────────────────────
const ATOM_COLORS = {
  C:'#222', H:'#444', N:'#1565c0', O:'#c62828', S:'#e65100',
  P:'#6a1b9a', F:'#00695c', Cl:'#2e7d32', Br:'#bf360c', I:'#4527a0',
  Si:'#546e7a', B:'#e65100', Se:'#4e342e', Na:'#1a237e', K:'#880e4f',
  default:'#222'
};
const CANVAS_BG = '#ffffff';
const BL = 44; // default bond length (world units)

// ─── State ────────────────────────────────────────────────────
let state = {
  atoms: [],   // {id, x, y, symbol, charge, radical}  radical: 0|1|2
  bonds: [],   // {id, a, b, order, stereo}  stereo: ''|'wedge'|'dash'
  nextId: 1,
  tool: 'draw',
  selectedElement: 'C',
  bondOrder: 1,
  bondStereo: '',
  selected: new Set(),
  history: [],
  redoStack: [],
  bwMode: false,
  showImplicitH: false,
  zoom: 1,
  panX: 0,
  panY: 0,
};

// ─── Implicit H helpers ───────────────────────────────────────
const MAX_VALENCE = {C:4,N:3,O:2,S:2,P:3,F:1,Cl:1,Br:1,I:1,B:3,Si:4,Se:2,H:1};
const SUB_DIGITS  = '₀₁₂₃₄₅₆₇₈₉';
function toSub(n) { return n<2?'':[...String(n)].map(d=>SUB_DIGITS[+d]).join(''); }

function getImplicitH(atom) {
  const v = MAX_VALENCE[atom.symbol];
  if (v === undefined) return 0;
  const bondSum = state.bonds
    .filter(b => b.a===atom.id || b.b===atom.id)
    .reduce((s,b) => s+(b.order||1), 0);
  return Math.max(0, v - bondSum);
}

// Direction H label is placed: opposite the average bond vector
function getHDir(atom) {
  const bonds = state.bonds.filter(b=>b.a===atom.id||b.b===atom.id);
  if (!bonds.length) return 'right';
  let sx=0, sy=0;
  bonds.forEach(b=>{
    const o=getAtom(b.a===atom.id?b.b:b.a);
    if(o){sx+=o.x-atom.x;sy+=o.y-atom.y;}
  });
  // H goes OPPOSITE the average bond direction
  if (Math.abs(sx)>=Math.abs(sy)) return sx>0?'left':'right';
  return sy>0?'up':'down';
}

// Full label text including implicit H (e.g. "CH₃", "NH₂", "OH")
function getFullLabel(atom) {
  const nH = state.showImplicitH ? getImplicitH(atom) : 0;
  if (nH===0) return atom.symbol;
  const h = 'H' + toSub(nH);
  const dir = getHDir(atom);
  return dir==='left' ? h+atom.symbol : atom.symbol+h;
}

let drag = null;
let hoveredAtom = null;
let hoveredBond = null;
let canvas, ctx;
let spaceDown = false;
let panning = false;
let panStart = {x:0, y:0};
let lassoPoints = null;

// ─── Init ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('chem-canvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  buildElementGrid();

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, {passive: false});
  canvas.addEventListener('contextmenu', onRightClick);
  canvas.addEventListener('dblclick', onDblClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', e => {
    if (e.key === ' ') { spaceDown = false; canvas.style.cursor = getCursor(); }
  });

  checkBackend();
  state.panX = 0; state.panY = 0;
  render();
});

function resizeCanvas() {
  const c = document.getElementById('canvas-container');
  canvas.width = c.clientWidth;
  canvas.height = c.clientHeight;
  render();
}

function buildElementGrid() {
  const grid = document.getElementById('element-grid');
  const elems = ['C','H','N','O','S','P','F','Cl','Br','I','Si','B','Se','Na'];
  elems.forEach(el => {
    const btn = document.createElement('button');
    btn.className = 'elem-btn' + (el==='C'?' active':'');
    btn.textContent = el;
    btn.onclick = () => selectElement(el);
    btn.id = 'elem-'+el;
    grid.appendChild(btn);
  });
}

// ─── Tool Management ──────────────────────────────────────────
function setTool(t) {
  state.tool = t;
  document.querySelectorAll('[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === t));
  canvas.style.cursor = getCursor();
  lassoPoints = null;
  render();
}

function getCursor() {
  if (spaceDown) return 'grab';
  if (state.tool === 'select') return 'default';
  if (state.tool === 'erase') return 'not-allowed';
  return 'crosshair';
}

function selectElement(el) {
  // If atoms are selected, replace their element
  if (state.selected.size > 0) {
    saveHistory();
    state.selected.forEach(id => {
      const a = getAtom(id);
      if (a) a.symbol = el;
    });
    render();
    return;
  }
  // Set drawing element; in select/erase/radical mode, also switch to draw
  state.selectedElement = el;
  document.querySelectorAll('.elem-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('elem-'+el);
  if (btn) btn.classList.add('active');
  const ci = document.getElementById('elem-custom');
  if (ci) ci.value = el;
  const drawModes = ['draw','ring3','ring4','ring5','ring6','ring6a','ring7','ring8','select'];
  if (!drawModes.includes(state.tool)) setTool('draw');
}

function setCustomElement() {
  const v = document.getElementById('elem-custom').value.trim();
  if (v) selectElement(v.charAt(0).toUpperCase() + v.slice(1).toLowerCase());
}

function setBond(order, stereo) {
  state.bondOrder = order;
  state.bondStereo = stereo || '';
  document.querySelectorAll('.bond-btn').forEach(b => b.classList.remove('active'));
  const key = stereo ? 'bond-'+stereo : ['','bond-single','bond-double','bond-triple'][order];
  const btn = document.getElementById(key);
  if (btn) btn.classList.add('active');
  setTool('draw');
}

function toggleBW() {
  state.bwMode = !state.bwMode;
  document.getElementById('btn-bw').classList.toggle('active', state.bwMode);
  render();
}

function toggleImplicitH() {
  state.showImplicitH = !state.showImplicitH;
  document.getElementById('btn-implH').classList.toggle('active', state.showImplicitH);
  render();
}

function zoomIn()  { applyZoom(1.2, canvas.width/2, canvas.height/2); }
function zoomOut() { applyZoom(0.83, canvas.width/2, canvas.height/2); }
function zoomFit() {
  if (!state.atoms.length) { state.zoom=1; state.panX=canvas.width/2; state.panY=canvas.height/2; render(); return; }
  const xs = state.atoms.map(a=>a.x), ys = state.atoms.map(a=>a.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
  const mw=maxX-minX||1, mh=maxY-minY||1, mg=80;
  state.zoom = Math.min((canvas.width-mg*2)/mw, (canvas.height-mg*2)/mh, 4);
  state.panX = (canvas.width-mw*state.zoom)/2 - minX*state.zoom;
  state.panY = (canvas.height-mh*state.zoom)/2 - minY*state.zoom;
  render();
}

function applyZoom(f, sx, sy) {
  const wx=(sx-state.panX)/state.zoom, wy=(sy-state.panY)/state.zoom;
  state.zoom = Math.max(0.1, Math.min(10, state.zoom*f));
  state.panX = sx - wx*state.zoom;
  state.panY = sy - wy*state.zoom;
  render();
}

// ─── History ──────────────────────────────────────────────────
function saveHistory() {
  state.history.push(JSON.stringify({atoms:state.atoms, bonds:state.bonds, nextId:state.nextId}));
  state.redoStack = [];
  if (state.history.length > 100) state.history.shift();
}

function undo() {
  if (!state.history.length) return;
  state.redoStack.push(JSON.stringify({atoms:state.atoms, bonds:state.bonds, nextId:state.nextId}));
  const p = JSON.parse(state.history.pop());
  state.atoms=p.atoms; state.bonds=p.bonds; state.nextId=p.nextId;
  state.selected.clear(); updateInfoBar(); render();
}

function redo() {
  if (!state.redoStack.length) return;
  state.history.push(JSON.stringify({atoms:state.atoms, bonds:state.bonds, nextId:state.nextId}));
  const p = JSON.parse(state.redoStack.pop());
  state.atoms=p.atoms; state.bonds=p.bonds; state.nextId=p.nextId;
  state.selected.clear(); updateInfoBar(); render();
}

// ─── Coordinate Transforms ───────────────────────────────────
function s2w(sx, sy) { return {x:(sx-state.panX)/state.zoom, y:(sy-state.panY)/state.zoom}; }
function canvasPos(e) { const r=canvas.getBoundingClientRect(); return {x:e.clientX-r.left, y:e.clientY-r.top}; }

// ─── Geometry ─────────────────────────────────────────────────
function dst(x1,y1,x2,y2) { return Math.hypot(x2-x1,y2-y1); }
function getAtom(id) { return state.atoms.find(a=>a.id===id); }
function getBondByAtoms(a,b) { return state.bonds.find(bd=>(bd.a===a&&bd.b===b)||(bd.a===b&&bd.b===a)); }
function getBondCount(id) { return state.bonds.filter(b=>b.a===id||b.b===id).length; }

function findAtomAt(wx, wy, r=14) {
  let best=null, bd=r;
  for (const a of state.atoms) { const d=dst(wx,wy,a.x,a.y); if (d<bd){bd=d;best=a;} }
  return best;
}

function findBondAt(wx, wy, tol=6) {
  for (const b of state.bonds) {
    const a1=getAtom(b.a), a2=getAtom(b.b);
    if (!a1||!a2) continue;
    const dx=a2.x-a1.x, dy=a2.y-a1.y, len=Math.hypot(dx,dy);
    if (len<1) continue;
    const t=((wx-a1.x)*dx+(wy-a1.y)*dy)/(len*len);
    if (t<0||t>1) continue;
    if (dst(wx,wy,a1.x+t*dx,a1.y+t*dy)<tol) return b;
  }
  return null;
}

function snapAngle(x1,y1,x2,y2) {
  const a=Math.atan2(y2-y1,x2-x1);
  const s=Math.round(a/(Math.PI/6))*(Math.PI/6);
  const d=Math.max(BL, dst(x1,y1,x2,y2));
  return {x:x1+Math.cos(s)*d, y:y1+Math.sin(s)*d};
}

// ─── Mouse Events ─────────────────────────────────────────────
function onWheel(e) {
  e.preventDefault();
  const {x:sx,y:sy}=canvasPos(e);
  applyZoom(e.deltaY<0?1.12:1/1.12, sx, sy);
}

function onMouseDown(e) {
  const {x:sx,y:sy}=canvasPos(e);
  if (e.button===1 || spaceDown) {
    panning=true; panStart={x:sx-state.panX, y:sy-state.panY};
    canvas.style.cursor='grabbing'; e.preventDefault(); return;
  }
  if (e.button!==0) return;
  const {x:wx,y:wy}=s2w(sx,sy);

  if (state.tool==='radical') {
    const a=findAtomAt(wx,wy);
    if (a) { saveHistory(); a.radical=((a.radical||0)+1)%3; render(); }
    return;
  }

  if (state.tool==='erase') {
    saveHistory();
    const a=findAtomAt(wx,wy);
    if (a){removeAtom(a.id);updateInfoBar();render();return;}
    const b=findBondAt(wx,wy);
    if (b){removeBond(b.id);render();}
    return;
  }

  if (state.tool==='select') {
    const a=findAtomAt(wx,wy);
    if (a) {
      if (!e.shiftKey) state.selected.clear();
      state.selected.add(a.id);
      drag={type:'move', startWX:wx, startWY:wy,
        origins:state.atoms.filter(at=>state.selected.has(at.id)).map(at=>({id:at.id,x:at.x,y:at.y}))};
    } else {
      if (!e.shiftKey) state.selected.clear();
      lassoPoints=[{x:wx,y:wy}];
    }
    render(); return;
  }

  if (state.tool.startsWith('ring')) {
    const aromatic = state.tool.endsWith('a');
    const n = parseInt(state.tool.replace('ring','').replace('a',''));
    saveHistory();
    insertRingAt(wx, wy, n, aromatic);
    return;
  }

  // draw tool
  saveHistory();
  const a=findAtomAt(wx,wy);
  if (a) {
    drag={type:'bond', atomId:a.id, startX:a.x, startY:a.y, curX:wx, curY:wy};
  } else {
    const na={id:state.nextId++,x:wx,y:wy,symbol:state.selectedElement,charge:0};
    state.atoms.push(na);
    drag={type:'bond', atomId:na.id, startX:wx, startY:wy, curX:wx, curY:wy};
  }
  render();
}

function onMouseMove(e) {
  const {x:sx,y:sy}=canvasPos(e);
  if (panning) {
    state.panX=sx-panStart.x; state.panY=sy-panStart.y; render(); return;
  }
  const {x:wx,y:wy}=s2w(sx,sy);
  document.getElementById('coords').textContent=`${wx.toFixed(0)}, ${wy.toFixed(0)}`;
  hoveredAtom=findAtomAt(wx,wy);
  hoveredBond=hoveredAtom?null:findBondAt(wx,wy);

  if (drag) {
    if (drag.type==='move') {
      const dx=wx-drag.startWX, dy=wy-drag.startWY;
      drag.origins.forEach(o=>{const a=getAtom(o.id);if(a){a.x=o.x+dx;a.y=o.y+dy;}});
    } else if (drag.type==='bond') {
      const tgt=findAtomAt(wx,wy);
      if (tgt&&tgt.id!==drag.atomId) { drag.curX=tgt.x; drag.curY=tgt.y; }
      else { const sn=snapAngle(drag.startX,drag.startY,wx,wy); drag.curX=sn.x; drag.curY=sn.y; }
    }
  }
  if (lassoPoints) lassoPoints.push({x:wx,y:wy});
  render();
}

function onMouseUp(e) {
  if (panning) { panning=false; canvas.style.cursor=getCursor(); return; }
  const {x:sx,y:sy}=canvasPos(e);
  const {x:wx,y:wy}=s2w(sx,sy);

  if (lassoPoints && lassoPoints.length>2) {
    state.atoms.forEach(a=>{ if(pointInPoly(a.x,a.y,lassoPoints)) state.selected.add(a.id); });
    lassoPoints=null; render(); return;
  }
  lassoPoints=null;
  if (!drag) return;

  if (drag.type==='bond') {
    const src=getAtom(drag.atomId);
    if (!src){drag=null;return;}
    let tgt=findAtomAt(drag.curX,drag.curY,18);
    if (tgt&&tgt.id!==src.id) {
      const ex=getBondByAtoms(src.id,tgt.id);
      if (ex) {
        if (state.bondStereo) { ex.stereo=ex.stereo===state.bondStereo?'':state.bondStereo; }
        else { ex.order=ex.order>=3?1:ex.order+1; ex.stereo=''; }
      } else {
        state.bonds.push({id:state.nextId++,a:src.id,b:tgt.id,order:state.bondOrder,stereo:state.bondStereo});
      }
    } else if (dst(drag.startX,drag.startY,drag.curX,drag.curY)>10) {
      const na={id:state.nextId++,x:drag.curX,y:drag.curY,symbol:state.selectedElement,charge:0};
      state.atoms.push(na);
      state.bonds.push({id:state.nextId++,a:src.id,b:na.id,order:state.bondOrder,stereo:state.bondStereo});
    }
    updateInfoBar();
  }
  drag=null; render(); localSMILES();
}

function onRightClick(e) {
  e.preventDefault();
  const {x:sx,y:sy}=canvasPos(e);
  const {x:wx,y:wy}=s2w(sx,sy);
  const a=findAtomAt(wx,wy);
  if (a) {
    saveHistory();
    const cyc=[0,1,-1,2,-2];
    const idx=cyc.indexOf(a.charge||0);
    a.charge=cyc[(idx+1)%cyc.length];
    render(); return;
  }
  const b=findBondAt(wx,wy);
  if (b) {
    saveHistory();
    const cyc=['','wedge','dash'];
    b.stereo=cyc[(cyc.indexOf(b.stereo||'')+1)%cyc.length];
    render();
  }
}

function onDblClick(e) {
  const {x:sx,y:sy}=canvasPos(e);
  const {x:wx,y:wy}=s2w(sx,sy);
  const a=findAtomAt(wx,wy);
  if (!a) return;
  const sym=prompt('原子記号:', a.symbol);
  if (sym&&sym.trim()) {
    saveHistory(); a.symbol=sym.trim(); render(); localSMILES();
  }
}

function onKeyDown(e) {
  if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if (e.key===' ') { e.preventDefault(); spaceDown=true; canvas.style.cursor='grab'; return; }
  if (e.key==='d'||e.key==='D') setTool('draw');
  if (e.key==='s'||e.key==='S') setTool('select');
  if (e.key==='e'||e.key==='E') setTool('erase');
  if (e.key==='b'||e.key==='B') toggleBW();
  if (e.key==='+'||e.key==='=') zoomIn();
  if (e.key==='-') zoomOut();
  if (e.key==='0') zoomFit();
  if ((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();undo();}
  if ((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z'))){e.preventDefault();redo();}
  if (e.key==='Delete'||e.key==='Backspace') {
    if (state.selected.size) {
      saveHistory(); state.selected.forEach(id=>removeAtom(id)); state.selected.clear();
      updateInfoBar(); render();
    } else if (hoveredAtom) {
      saveHistory(); removeAtom(hoveredAtom.id); hoveredAtom=null; updateInfoBar(); render();
    }
  }
  if (e.key==='Escape') { state.selected.clear(); lassoPoints=null; render(); }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 2 : 10;
    const dx = e.key==='ArrowLeft'?-step : e.key==='ArrowRight'?step : 0;
    const dy = e.key==='ArrowUp'  ?-step : e.key==='ArrowDown' ?step : 0;
    const targets = state.selected.size>0
      ? state.atoms.filter(a=>state.selected.has(a.id))
      : state.atoms;
    if (targets.length) { saveHistory(); targets.forEach(a=>{a.x+=dx/state.zoom; a.y+=dy/state.zoom;}); render(); }
  }
  if (e.key==='a'&&(e.ctrlKey||e.metaKey)) { e.preventDefault(); state.atoms.forEach(a=>state.selected.add(a.id)); render(); }
}

// ─── Atom/Bond Ops ────────────────────────────────────────────
function removeAtom(id) {
  state.atoms=state.atoms.filter(a=>a.id!==id);
  state.bonds=state.bonds.filter(b=>b.a!==id&&b.b!==id);
}
function removeBond(id) { state.bonds=state.bonds.filter(b=>b.id!==id); }

// ─── Ring tool placement ──────────────────────────────────────
function insertRingAt(wx, wy, n, aromatic) {
  const sz = n===3?0.577:n===4?0.707:n===5?0.851:n===6?1.0:n===7?1.152:1.305;
  const R = BL * sz;
  const sa = n%2===0 ? -Math.PI/n : -Math.PI/2;

  const ids = [];
  for (let i=0; i<n; i++) {
    const angle = sa + (i/n)*2*Math.PI;
    const x = wx+Math.cos(angle)*R, y = wy+Math.sin(angle)*R;
    const ex = findAtomAt(x, y, BL*0.4);
    if (ex) { ids.push(ex.id); }
    else {
      const na = {id:state.nextId++, x, y, symbol:state.selectedElement, charge:0};
      state.atoms.push(na);
      ids.push(na.id);
    }
  }
  for (let i=0; i<n; i++) {
    const a=ids[i], b=ids[(i+1)%n];
    if (!getBondByAtoms(a,b)) {
      const order = aromatic ? (i%2===0 ? 2 : 1) : 1;
      state.bonds.push({id:state.nextId++,a,b,order,stereo:''});
    }
  }
  updateInfoBar(); render(); localSMILES();
}

// ─── Rendering ────────────────────────────────────────────────
function render() {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle=CANVAS_BG;
  ctx.fillRect(0,0,canvas.width,canvas.height);

  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);

  // grid dots
  if (state.zoom>0.4) {
    const GRID=40;
    const x0=Math.ceil(-state.panX/state.zoom/GRID)*GRID;
    const y0=Math.ceil(-state.panY/state.zoom/GRID)*GRID;
    const x1=(canvas.width-state.panX)/state.zoom;
    const y1=(canvas.height-state.panY)/state.zoom;
    ctx.fillStyle='#e8e8e8';
    for (let x=x0;x<x1;x+=GRID)
      for (let y=y0;y<y1;y+=GRID) {
        ctx.beginPath(); ctx.arc(x,y,0.8/state.zoom,0,Math.PI*2); ctx.fill();
      }
  }

  // bonds
  for (const b of state.bonds) {
    const a1=getAtom(b.a), a2=getAtom(b.b);
    if (a1&&a2) drawBond(a1,a2,b);
  }

  // drag preview
  if (drag&&drag.type==='bond') {
    ctx.save();
    ctx.strokeStyle='#1565c0'; ctx.lineWidth=1.5/state.zoom;
    ctx.setLineDash([6/state.zoom,4/state.zoom]);
    ctx.beginPath(); ctx.moveTo(drag.startX,drag.startY); ctx.lineTo(drag.curX,drag.curY); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }

  // atoms
  for (const a of state.atoms) drawAtom(a);

  // lasso
  if (lassoPoints&&lassoPoints.length>1) {
    ctx.save();
    ctx.strokeStyle='#1565c0'; ctx.lineWidth=1/state.zoom;
    ctx.setLineDash([4/state.zoom,3/state.zoom]);
    ctx.fillStyle='rgba(21,101,192,0.06)';
    ctx.beginPath();
    lassoPoints.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }

  // selection highlights
  for (const id of state.selected) {
    const a=getAtom(id); if (!a) continue;
    ctx.beginPath(); ctx.arc(a.x,a.y,13/state.zoom,0,Math.PI*2);
    ctx.fillStyle='rgba(21,101,192,0.12)'; ctx.fill();
    ctx.strokeStyle='#1565c0'; ctx.lineWidth=1/state.zoom; ctx.stroke();
  }

  ctx.restore();
}

function showLabel(a) {
  if (a.symbol!=='C') return true;
  if (getBondCount(a.id)===0) return true;
  return state.showImplicitH && getImplicitH(a)>0;
}

function labelHalfWidth(a) {
  if (!showLabel(a)) return 0;
  const label = getFullLabel(a);
  const fs = label.length>3 ? 13 : label.length>2 ? 14 : label.length>1 ? 16 : 18;
  ctx.font = `bold ${fs/state.zoom}px sans-serif`;
  return ctx.measureText(label).width/2 + 1/state.zoom;
}

// Returns +1/-1 indicating which perpendicular side (px,py) the ring interior is on,
// or 0 if the bond is not in a ring.
function getRingInsideSide(a1, a2, px, py) {
  // BFS from a1 to a2 avoiding the direct a1-a2 bond, max ring size 10
  const visited = new Set([a1.id]);
  const queue = [[a1.id, [a1]]];
  while (queue.length) {
    const [cur, path] = queue.shift();
    if (path.length > 9) continue;
    const neighbors = state.bonds
      .filter(b => (b.a===cur||b.b===cur) && !(b.a===a1.id&&b.b===a2.id) && !(b.a===a2.id&&b.b===a1.id))
      .map(b => b.a===cur ? b.b : b.a);
    for (const nb of neighbors) {
      if (nb===a2.id) {
        // compute centroid of ring path atoms
        const cx = path.reduce((s,a)=>s+a.x,0)/path.length;
        const cy = path.reduce((s,a)=>s+a.y,0)/path.length;
        const dot = (cx-a1.x)*px + (cy-a1.y)*py;
        return dot > 0 ? 1 : -1;
      }
      if (!visited.has(nb)) {
        visited.add(nb);
        const atom = getAtom(nb);
        if (atom) queue.push([nb, [...path, atom]]);
      }
    }
  }
  return 0;
}

function drawBond(a1, a2, bond) {
  const dx=a2.x-a1.x, dy=a2.y-a1.y, len=Math.hypot(dx,dy);
  if (len<1) return;
  const ux=dx/len, uy=dy/len, px=-uy, py=ux;
  const r1=labelHalfWidth(a1);
  const r2=labelHalfWidth(a2);
  const x1=a1.x+ux*r1, y1=a1.y+uy*r1;
  const x2=a2.x-ux*r2, y2=a2.y-uy*r2;
  const segLen=Math.hypot(x2-x1,y2-y1); if(segLen<2) return;

  const isSel=state.selected.has(a1.id)||state.selected.has(a2.id);
  const isHov=hoveredBond&&hoveredBond.id===bond.id;
  const col=state.bwMode?'#000':isHov?'#1565c0':isSel?'#1565c0':'#333';
  const lw=1.8/state.zoom;
  ctx.strokeStyle=col; ctx.lineWidth=lw; ctx.lineCap='round';

  const st=bond.stereo||'';
  const ord=bond.order||1;

  if (st==='wedge') {
    drawWedge(a1.x,a1.y,x2,y2,true,col,a1,a2,bond.id);
  } else if (st==='dash') {
    drawWedge(a1.x,a1.y,x2,y2,false,col,a1,a2,bond.id);
  } else if (ord===1) {
    line(x1,y1,x2,y2);
  } else if (ord===2) {
    const side = getRingInsideSide(a1, a2, px, py);
    if (side !== 0) {
      // Ring bond: main line full length, inner line shorter and offset inward
      const off=3.5/state.zoom, inset=3/state.zoom;
      line(x1,y1,x2,y2);
      line(x1+px*off*side+ux*inset, y1+py*off*side+uy*inset,
           x2+px*off*side-ux*inset, y2+py*off*side-uy*inset);
    } else {
      const off=2.5/state.zoom;
      line(x1+px*off,y1+py*off,x2+px*off,y2+py*off);
      line(x1-px*off,y1-py*off,x2-px*off,y2-py*off);
    }
  } else if (ord===3) {
    const off=3.5/state.zoom;
    line(x1,y1,x2,y2);
    line(x1+px*off,y1+py*off,x2+px*off,y2+py*off);
    line(x1-px*off,y1-py*off,x2-px*off,y2-py*off);
  }
}

function wedgeCorners(x1,y1,x2,y2,srcAtom,termAtom,bondId) {
  const dx=x2-x1, dy=y2-y1, len=Math.hypot(dx,dy);
  const ux=dx/len, uy=dy/len;
  const px=-uy, py=ux, w=4/state.zoom;

  let c1x=x2+px*w, c1y=y2+py*w;
  let c2x=x2-px*w, c2y=y2-py*w;
  let s1x=x1,      s1y=y1;
  let s2x=x1,      s2y=y1;

  const intersect=(ox,oy,ex,ey,atom,aux,auy)=>{
    const denom=ex*auy-ey*aux;
    if (Math.abs(denom)<1e-6) return null;
    const t=((atom.x-ox)*auy-(atom.y-oy)*aux)/denom;
    return t>0.1 && t<len*2 ? {x:ox+t*ex, y:oy+t*ey} : null;
  };

  if (termAtom) {
    const adj=state.bonds.filter(b=>b.id!==bondId&&(b.a===termAtom.id||b.b===termAtom.id));
    for (const b of adj) {
      const other=getAtom(b.a===termAtom.id?b.b:b.a);
      if (!other) continue;
      const adx=other.x-termAtom.x, ady=other.y-termAtom.y, al=Math.hypot(adx,ady);
      const aux=adx/al, auy=ady/al;
      if (aux*ux+auy*uy < -0.3) continue;
      const cross=aux*uy-auy*ux;
      if (cross>0.1) {
        const p=intersect(x1,y1,c1x-x1,c1y-y1,termAtom,aux,auy);
        if (p){c1x=p.x;c1y=p.y;}
      } else if (cross<-0.1) {
        const p=intersect(x1,y1,c2x-x1,c2y-y1,termAtom,aux,auy);
        if (p){c2x=p.x;c2y=p.y;}
      }
    }
  }

  if (srcAtom) {
    const adj=state.bonds.filter(b=>b.id!==bondId&&(b.a===srcAtom.id||b.b===srcAtom.id));
    for (const b of adj) {
      const other=getAtom(b.a===srcAtom.id?b.b:b.a);
      if (!other) continue;
      const adx=other.x-srcAtom.x, ady=other.y-srcAtom.y, al=Math.hypot(adx,ady);
      const aux=adx/al, auy=ady/al;
      if (aux*ux+auy*uy > 0.3) continue;
      const cross=aux*uy-auy*ux;
      if (cross>0.1) {
        const p=intersect(x2,y2,s1x-x2,s1y-y2,srcAtom,aux,auy);
        if (p){s1x=p.x;s1y=p.y;}
      } else if (cross<-0.1) {
        const p=intersect(x2,y2,s2x-x2,s2y-y2,srcAtom,aux,auy);
        if (p){s2x=p.x;s2y=p.y;}
      }
    }
  }

  return {s1x,s1y,s2x,s2y,c1x,c1y,c2x,c2y,dx,dy,len};
}

function drawWedge(x1,y1,x2,y2,filled,col,srcAtom,termAtom,bondId) {
  const {s1x,s1y,s2x,s2y,c1x,c1y,c2x,c2y,dx,dy,len}=wedgeCorners(x1,y1,x2,y2,srcAtom,termAtom,bondId);
  if (filled) {
    ctx.beginPath();
    ctx.moveTo(s1x,s1y); ctx.lineTo(c1x,c1y);
    ctx.lineTo(c2x,c2y); ctx.lineTo(s2x,s2y);
    ctx.closePath(); ctx.fillStyle=col; ctx.fill();
  } else {
    const n=Math.max(3,Math.round(len/(7/state.zoom)));
    ctx.lineWidth=1.2/state.zoom;
    for (let i=0;i<=n;i++) {
      const t=i/n;
      line(s1x+(c1x-s1x)*t, s1y+(c1y-s1y)*t, s2x+(c2x-s2x)*t, s2y+(c2y-s2y)*t);
    }
  }
}

function line(x1,y1,x2,y2) {
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
}

function drawAtom(a) {
  const hov=hoveredAtom&&hoveredAtom.id===a.id;
  const sel=state.selected.has(a.id);
  const sl=showLabel(a);
  const sc=1/state.zoom;

  if (sl) {
    const label=getFullLabel(a);
    const fsBase=label.length>3?13:label.length>2?14:label.length>1?16:18;
    const fs=fsBase*sc;
    ctx.font=`bold ${fs}px sans-serif`;
    const tw=ctx.measureText(label).width;
    const pad=4*sc, rw=tw/2+pad, rh=fs/2+pad;

    ctx.fillStyle=hov?'#e3f2fd':CANVAS_BG;
    ctx.fillRect(a.x-rw,a.y-rh,rw*2,rh*2);

    if (hov||sel) {
      ctx.strokeStyle='#1565c0'; ctx.lineWidth=sc;
      ctx.strokeRect(a.x-rw,a.y-rh,rw*2,rh*2);
    }

    ctx.fillStyle=state.bwMode?'#000':(ATOM_COLORS[a.symbol]||ATOM_COLORS.default);
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(label, a.x, a.y);

    // charge superscript
    if (a.charge) {
      const cs=a.charge===1?'+':a.charge===-1?'−':a.charge>0?`${a.charge}+`:`${Math.abs(a.charge)}−`;
      ctx.font=`bold ${9*sc}px sans-serif`;
      ctx.fillStyle=state.bwMode?'#000':'#c62828';
      ctx.textAlign='left'; ctx.textBaseline='top';
      ctx.fillText(cs, a.x+rw, a.y-rh);
    }

    // radical dots (top-right)
    if (a.radical) {
      const r=2.5*sc, gap=2*sc;
      ctx.fillStyle=state.bwMode?'#000':'#333';
      for (let i=0;i<a.radical;i++) {
        ctx.beginPath();
        ctx.arc(a.x+rw+gap+r+i*(r*2.8), a.y-rh/2, r, 0, Math.PI*2);
        ctx.fill();
      }
    }
  } else {
    // skeletal C: no label, just interaction indicator
    if (getBondCount(a.id)===0) {
      const fs=18*sc;
      ctx.font=`bold ${fs}px sans-serif`;
      const tw=ctx.measureText('C').width, pad=3*sc, rw=tw/2+pad, rh=fs/2+pad;
      ctx.fillStyle=CANVAS_BG; ctx.fillRect(a.x-rw,a.y-rh,rw*2,rh*2);
      ctx.fillStyle=state.bwMode?'#000':'#333';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('C',a.x,a.y);
    }
    // radical dots on skeletal C (no label box) — dots near vertex
    if (a.radical) {
      const r=2.5*sc;
      ctx.fillStyle=state.bwMode?'#000':'#333';
      for (let i=0;i<a.radical;i++) {
        ctx.beginPath();
        ctx.arc(a.x+6*sc+i*r*3, a.y-6*sc, r, 0, Math.PI*2);
        ctx.fill();
      }
    }
    if (hov) {
      ctx.beginPath(); ctx.arc(a.x,a.y,7*sc,0,Math.PI*2);
      ctx.fillStyle='rgba(21,101,192,0.15)'; ctx.fill();
      ctx.strokeStyle='#1565c0'; ctx.lineWidth=sc; ctx.stroke();
    }
  }
}

// ─── Info Bar ─────────────────────────────────────────────────
function updateInfoBar() {
  document.getElementById('atom-count').textContent=state.atoms.length;
  document.getElementById('bond-count').textContent=state.bonds.length;
}

// ─── Lasso helper ─────────────────────────────────────────────
function pointInPoly(x,y,poly) {
  let inside=false;
  for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if (((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

// ─── Templates ────────────────────────────────────────────────
function insertTemplate(name) {
  saveHistory();
  const tpl = TEMPLATES[name];
  if (!tpl) { console.warn('Unknown template:', name); return; }
  const {atoms:ta, bonds:tb} = tpl(BL);

  // center template at view center
  const cx=(canvas.width/2-state.panX)/state.zoom;
  const cy=(canvas.height/2-state.panY)/state.zoom;

  const map={};
  ta.forEach(a => {
    const id=state.nextId++;
    map[a.idx]=id;
    state.atoms.push({id,x:cx+a.x,y:cy+a.y,symbol:a.sym||a.symbol||'C',charge:a.charge||0});
  });
  tb.forEach(b => {
    if (map[b.i]!==undefined&&map[b.j]!==undefined)
      state.bonds.push({id:state.nextId++,a:map[b.i],b:map[b.j],order:b.order||1,stereo:b.stereo||''});
  });
  updateInfoBar(); render(); localSMILES();
}

function mkRing(n, syms, ox, oy, R, startAngle, alt) {
  const atoms=[], bonds=[];
  for (let i=0;i<n;i++) {
    const ang=startAngle+(i/n)*2*Math.PI;
    atoms.push({idx:i,sym:syms[i]||'C',x:ox+Math.cos(ang)*R,y:oy+Math.sin(ang)*R});
  }
  for (let i=0;i<n;i++) bonds.push({i,j:(i+1)%n,order:alt?(i%2===0?2:1):1});
  return {atoms,bonds};
}

function addAtom(atoms,bonds,idx,sym,x,y,fromIdx,bondOrder) {
  atoms.push({idx,sym,x,y});
  if (fromIdx!==undefined) bonds.push({i:fromIdx,j:idx,order:bondOrder||1});
}

const TEMPLATES = {
  // ── Basic rings ──────────────────────────────────────────────
  'benzene':     L => mkRing(6,Array(6).fill('C'),0,0,L,-Math.PI/2,true),
  'cyclohexane': L => mkRing(6,Array(6).fill('C'),0,0,L,-Math.PI/2,false),
  'cyclopentane':L => mkRing(5,Array(5).fill('C'),0,0,L*0.851,-Math.PI/2,false),
  'cyclobutane': L => mkRing(4,Array(4).fill('C'),0,0,L*0.707,-Math.PI/4,false),
  'cyclopropane':L => mkRing(3,Array(3).fill('C'),0,0,L*0.577,-Math.PI/2,false),

  'naphthalene': L => {
    const H=L*0.866;
    // left hex center at (-H,0), right at (+H,0)
    // shared bond: atoms at (0,-L/2) and (0,L/2)
    const atoms=[
      {idx:0,sym:'C',x:0,    y:-L/2},  // shared top
      {idx:1,sym:'C',x:0,    y: L/2},  // shared bottom
      // left ring
      {idx:2,sym:'C',x:-H,   y:-L},
      {idx:3,sym:'C',x:-2*H, y:-L/2},
      {idx:4,sym:'C',x:-2*H, y: L/2},
      {idx:5,sym:'C',x:-H,   y: L},
      // right ring
      {idx:6,sym:'C',x: H,   y:-L},
      {idx:7,sym:'C',x: 2*H, y:-L/2},
      {idx:8,sym:'C',x: 2*H, y: L/2},
      {idx:9,sym:'C',x: H,   y: L},
    ];
    const bonds=[
      {i:0,j:1,order:1},   // shared bond
      // left ring
      {i:0,j:2,order:2},{i:2,j:3,order:1},{i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:1,order:2},
      // right ring
      {i:0,j:6,order:2},{i:6,j:7,order:1},{i:7,j:8,order:2},{i:8,j:9,order:1},{i:9,j:1,order:2},
    ];
    return {atoms,bonds};
  },

  'anthracene': L => {
    const H=L*0.866;
    const atoms=[
      {idx:0,sym:'C',x:0,    y:-L/2},{idx:1,sym:'C',x:0,    y: L/2},
      {idx:2,sym:'C',x:-H,   y:-L},  {idx:3,sym:'C',x:-2*H, y:-L/2},
      {idx:4,sym:'C',x:-2*H, y: L/2},{idx:5,sym:'C',x:-H,   y: L},
      {idx:6,sym:'C',x: H,   y:-L},  {idx:7,sym:'C',x: 2*H, y:-L/2},
      {idx:8,sym:'C',x: 2*H, y: L/2},{idx:9,sym:'C',x: H,   y: L},
      {idx:10,sym:'C',x:3*H, y:-L},  {idx:11,sym:'C',x:4*H, y:-L/2},
      {idx:12,sym:'C',x:4*H, y: L/2},{idx:13,sym:'C',x:3*H, y: L},
    ];
    const bonds=[
      {i:0,j:1,order:1},
      {i:0,j:2,order:2},{i:2,j:3,order:1},{i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:1,order:2},
      {i:0,j:6,order:2},{i:6,j:7,order:1},{i:7,j:8,order:2},{i:8,j:9,order:1},{i:9,j:1,order:2},
      {i:7,j:10,order:2},{i:10,j:11,order:1},{i:11,j:12,order:2},{i:12,j:13,order:1},{i:13,j:8,order:2},
    ];
    return {atoms,bonds};
  },

  // ── Heteroaromatics ──────────────────────────────────────────
  'pyridine':   L => mkRing(6,['N','C','C','C','C','C'],0,0,L,-Math.PI/2,true),
  'pyrimidine': L => mkRing(6,['N','C','N','C','C','C'],0,0,L,-Math.PI/2,true),
  'pyrazine':   L => mkRing(6,['N','C','C','N','C','C'],0,0,L,-Math.PI/2,true),
  'imidazole':  L => mkRing(5,['N','C','N','C','C'],0,0,L*0.851,-Math.PI/2,true),
  'pyrazole':   L => mkRing(5,['N','N','C','C','C'],0,0,L*0.851,-Math.PI/2,true),
  'oxazole':    L => mkRing(5,['O','C','N','C','C'],0,0,L*0.851,-Math.PI/2,true),
  'furan':      L => mkRing(5,['O','C','C','C','C'],0,0,L*0.851,-Math.PI/2,true),
  'thiophene':  L => mkRing(5,['S','C','C','C','C'],0,0,L*0.851,-Math.PI/2,true),
  'pyrrole':    L => mkRing(5,['N','C','C','C','C'],0,0,L*0.851,-Math.PI/2,true),
  'indole':     L => {
    // benzene fused with pyrrole
    const H=L*0.866;
    const atoms=[
      // benzene part
      {idx:0,sym:'C',x:0,    y:-L/2},{idx:1,sym:'C',x:0,    y: L/2},
      {idx:2,sym:'C',x:-H,   y:-L},  {idx:3,sym:'C',x:-2*H, y:-L/2},
      {idx:4,sym:'C',x:-2*H, y: L/2},{idx:5,sym:'C',x:-H,   y: L},
      // pyrrole part (fused at 0-1 bond)
      {idx:6,sym:'N',x: H,   y: L},
      {idx:7,sym:'C',x: 2*H, y: L/2},
      {idx:8,sym:'C',x: 2*H, y:-L/2},
    ];
    const bonds=[
      {i:0,j:1,order:1},
      {i:0,j:2,order:2},{i:2,j:3,order:1},{i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:1,order:2},
      {i:1,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:2},{i:8,j:0,order:1},
    ];
    return {atoms,bonds};
  },

  // ── Nucleobases ───────────────────────────────────────────────
  // Purine scaffold (adenine/guanine base)
  'adenine': L => {
    // Proper purine geometry: 6-ring (pyrimidine) + 5-ring (imidazole)
    // 6-ring as regular hexagon with flat top, bond length L
    // N1(-1,0) C2(-0.5,0.866) N3(0.5,0.866) C4(1,0) C5(0.5,-0.866) C6(-0.5,-0.866)
    // 5-ring computed from C4-C5 bond, extending right: N7(1.978,-0.207) C8(2.083,-1.203) N9(1.169,-1.609)
    const s = L;
    const atoms = [
      {idx:0, sym:'N', x:-s,      y: 0},        // N1
      {idx:1, sym:'C', x:-s*0.5,  y: s*0.866},  // C2
      {idx:2, sym:'N', x: s*0.5,  y: s*0.866},  // N3
      {idx:3, sym:'C', x: s,      y: 0},        // C4 ← fused
      {idx:4, sym:'C', x: s*0.5,  y:-s*0.866},  // C5 ← fused
      {idx:5, sym:'C', x:-s*0.5,  y:-s*0.866},  // C6
      {idx:6, sym:'N', x: s*1.978,y:-s*0.207},  // N7
      {idx:7, sym:'C', x: s*2.083,y:-s*1.203},  // C8
      {idx:8, sym:'N', x: s*1.169,y:-s*1.609},  // N9
      {idx:9, sym:'N', x:-s,      y:-s*1.732},  // NH2 exocyclic (at C6)
    ];
    const bonds = [
      {i:0,j:1,order:2},{i:1,j:2,order:1},{i:2,j:3,order:2},
      {i:3,j:4,order:1},{i:4,j:5,order:2},{i:5,j:0,order:1},
      {i:3,j:6,order:1},{i:6,j:7,order:2},{i:7,j:8,order:1},{i:8,j:4,order:1},
      {i:5,j:9,order:1},
    ];
    return {atoms,bonds};
  },

  'guanine': L => {
    const s = L;
    const atoms = [
      {idx:0, sym:'N', x:-s,      y: 0},
      {idx:1, sym:'C', x:-s*0.5,  y: s*0.866},
      {idx:2, sym:'N', x: s*0.5,  y: s*0.866},
      {idx:3, sym:'C', x: s,      y: 0},
      {idx:4, sym:'C', x: s*0.5,  y:-s*0.866},
      {idx:5, sym:'C', x:-s*0.5,  y:-s*0.866},
      {idx:6, sym:'N', x: s*1.978,y:-s*0.207},
      {idx:7, sym:'C', x: s*2.083,y:-s*1.203},
      {idx:8, sym:'N', x: s*1.169,y:-s*1.609},
      {idx:9, sym:'N', x:-s*1.5,  y: s*0.866},  // NH2 at C2
      {idx:10,sym:'O', x:-s,      y:-s*1.732},  // =O at C6
    ];
    const bonds = [
      {i:0,j:1,order:1},{i:1,j:2,order:2},{i:2,j:3,order:1},
      {i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:0,order:2},
      {i:3,j:6,order:1},{i:6,j:7,order:2},{i:7,j:8,order:1},{i:8,j:4,order:1},
      {i:1,j:9,order:1},
      {i:5,j:10,order:2},
    ];
    return {atoms,bonds};
  },

  'cytosine': L => {
    // pyrimidine with NH2 at C4 and =O at C2
    const a=L, h=a*0.866;
    const atoms=[
      {idx:0,sym:'N',x:0,    y:0},       // N1
      {idx:1,sym:'C',x:a*0.5,y:-h},      // C2
      {idx:2,sym:'N',x:a*1.5,y:-h},      // N3
      {idx:3,sym:'C',x:a*2,  y:0},       // C4
      {idx:4,sym:'C',x:a*1.5,y: h},      // C5
      {idx:5,sym:'C',x:a*0.5,y: h},      // C6
      {idx:6,sym:'O',x:a*0.5,y:-2*h},    // =O at C2
      {idx:7,sym:'N',x:a*3,  y:0},       // NH2 at C4
    ];
    const bonds=[
      {i:0,j:1,order:1},{i:1,j:2,order:2},{i:2,j:3,order:1},
      {i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:0,order:2},
      {i:1,j:6,order:2},
      {i:3,j:7,order:1},
    ];
    return {atoms,bonds};
  },

  'thymine': L => {
    const a=L, h=a*0.866;
    const atoms=[
      {idx:0,sym:'N',x:0,    y:0},
      {idx:1,sym:'C',x:a*0.5,y:-h},
      {idx:2,sym:'N',x:a*1.5,y:-h},
      {idx:3,sym:'C',x:a*2,  y:0},
      {idx:4,sym:'C',x:a*1.5,y: h},
      {idx:5,sym:'C',x:a*0.5,y: h},
      {idx:6,sym:'O',x:a*0.5,y:-2*h},
      {idx:7,sym:'O',x:a*3,  y:0},
      {idx:8,sym:'C',x:a*1.5,y:2*h},  // methyl at C5
    ];
    const bonds=[
      {i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:1},
      {i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:0,order:2},
      {i:1,j:6,order:2},{i:3,j:7,order:2},{i:4,j:8,order:1},
    ];
    return {atoms,bonds};
  },

  'uracil': L => {
    const a=L, h=a*0.866;
    const atoms=[
      {idx:0,sym:'N',x:0,    y:0},
      {idx:1,sym:'C',x:a*0.5,y:-h},
      {idx:2,sym:'N',x:a*1.5,y:-h},
      {idx:3,sym:'C',x:a*2,  y:0},
      {idx:4,sym:'C',x:a*1.5,y: h},
      {idx:5,sym:'C',x:a*0.5,y: h},
      {idx:6,sym:'O',x:a*0.5,y:-2*h},
      {idx:7,sym:'O',x:a*3,  y:0},
    ];
    const bonds=[
      {i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:1},
      {i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:0,order:2},
      {i:1,j:6,order:2},{i:3,j:7,order:2},
    ];
    return {atoms,bonds};
  },

  // ── Amino acids ───────────────────────────────────────────────
  'glycine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,   y:0},
      {idx:1,sym:'C',x:0,    y:0},
      {idx:2,sym:'C',x:L,    y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},
      {idx:4,sym:'O',x:L*1.5,y: L*0.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1}]
  }),

  'alanine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,   y:0},
      {idx:1,sym:'C',x:0,    y:0},
      {idx:2,sym:'C',x:L,    y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},
      {idx:4,sym:'O',x:L*1.5,y: L*0.866},
      {idx:5,sym:'C',x:0,    y:-L},  // methyl
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},{i:1,j:5,order:1}]
  }),

  'valine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,   y:0},
      {idx:1,sym:'C',x:0,    y:0},
      {idx:2,sym:'C',x:L,    y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},
      {idx:4,sym:'O',x:L*1.5,y: L*0.866},
      {idx:5,sym:'C',x:0,    y:-L},
      {idx:6,sym:'C',x:-L*0.5,y:-L*1.866},
      {idx:7,sym:'C',x:L*0.5,y:-L*1.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:5,j:7,order:1}]
  }),

  'serine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,   y:0},
      {idx:1,sym:'C',x:0,    y:0},
      {idx:2,sym:'C',x:L,    y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},
      {idx:4,sym:'O',x:L*1.5,y: L*0.866},
      {idx:5,sym:'C',x:0,    y:-L},
      {idx:6,sym:'O',x:L*0.5,y:-L*1.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1}]
  }),

  'cysteine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,   y:0},
      {idx:1,sym:'C',x:0,    y:0},
      {idx:2,sym:'C',x:L,    y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},
      {idx:4,sym:'O',x:L*1.5,y: L*0.866},
      {idx:5,sym:'C',x:0,    y:-L},
      {idx:6,sym:'S',x:L*0.5,y:-L*1.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1}]
  }),

  'phenylalanine': L => {
    const ring = mkRing(6,Array(6).fill('C'),0,-L*2.5,L,-Math.PI/2,true);
    const backbone = {
      atoms:[
        {idx:10,sym:'N',x:-L,y:0},{idx:11,sym:'C',x:0,y:0},
        {idx:12,sym:'C',x:L,y:0},{idx:13,sym:'O',x:L*1.5,y:-L*0.866},
        {idx:14,sym:'O',x:L*1.5,y:L*0.866},{idx:15,sym:'C',x:0,y:-L},
      ],
      bonds:[{i:10,j:11,order:1},{i:11,j:12,order:1},{i:12,j:13,order:2},{i:12,j:14,order:1},
             {i:11,j:15,order:1}]
    };
    // connect CH2 (idx15) to ring atom at bottom (idx that has y closest to 0 in ring)
    // ring atom 0 is at top (y=-L*2.5-L), atom 3 is at bottom (y=-L*2.5+L)
    const allAtoms=[...ring.atoms,...backbone.atoms];
    const allBonds=[...ring.bonds,...backbone.bonds,{i:15,j:3,order:1}];
    return {atoms:allAtoms, bonds:allBonds};
  },

  'tyrosine': L => {
    const ring = mkRing(6,Array(6).fill('C'),0,-L*2.5,L,-Math.PI/2,true);
    const backbone = {
      atoms:[
        {idx:10,sym:'N',x:-L,y:0},{idx:11,sym:'C',x:0,y:0},
        {idx:12,sym:'C',x:L,y:0},{idx:13,sym:'O',x:L*1.5,y:-L*0.866},
        {idx:14,sym:'O',x:L*1.5,y:L*0.866},{idx:15,sym:'C',x:0,y:-L},
        {idx:16,sym:'O',x:0,y:-L*3.5-L},  // para-OH
      ],
      bonds:[{i:10,j:11,order:1},{i:11,j:12,order:1},{i:12,j:13,order:2},{i:12,j:14,order:1},
             {i:11,j:15,order:1},{i:3,j:16,order:1}]
    };
    return {atoms:[...ring.atoms,...backbone.atoms], bonds:[...ring.bonds,...backbone.bonds,{i:15,j:3,order:1}]};
  },

  'tryptophan': L => {
    // indole sidechain
    const ind = TEMPLATES['indole'](L);
    // shift indole to be centered below backbone
    ind.atoms.forEach(a=>{a.x+=0;a.y+=L*2;});
    const backbone = {
      atoms:[
        {idx:20,sym:'N',x:-L,y:-L*1},{idx:21,sym:'C',x:0,y:-L*1},
        {idx:22,sym:'C',x:L,y:-L*1},{idx:23,sym:'O',x:L*1.5,y:-L*1-L*0.866},
        {idx:24,sym:'O',x:L*1.5,y:-L*1+L*0.866},{idx:25,sym:'C',x:0,y:0},
      ],
      bonds:[{i:20,j:21,order:1},{i:21,j:22,order:1},{i:22,j:23,order:2},{i:22,j:24,order:1},
             {i:21,j:25,order:1}]
    };
    // connect CH2 to indole C3 (idx 8 in indole which is C8)
    return {atoms:[...ind.atoms,...backbone.atoms],
            bonds:[...ind.bonds,...backbone.bonds,{i:25,j:8,order:1}]};
  },

  'aspartate': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,   y:0},
      {idx:1,sym:'C',x:0,    y:0},
      {idx:2,sym:'C',x:L,    y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},
      {idx:4,sym:'O',x:L*1.5,y: L*0.866},
      {idx:5,sym:'C',x:0,    y:-L},
      {idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'O',x:L*1.5,y:-L*1.866},
      {idx:8,sym:'O',x:0,    y:-L*2.732},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:2},{i:6,j:8,order:1}]
  }),

  'glutamate': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,   y:0},
      {idx:1,sym:'C',x:0,    y:0},
      {idx:2,sym:'C',x:L,    y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},
      {idx:4,sym:'O',x:L*1.5,y: L*0.866},
      {idx:5,sym:'C',x:0,    y:-L},
      {idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'C',x:0,    y:-L*2.732},
      {idx:8,sym:'O',x:L,    y:-L*2.732},
      {idx:9,sym:'O',x:-L*0.5,y:-L*3.598},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:2},{i:7,j:9,order:1}]
  }),

  'lysine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'C',x:L,y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},{idx:4,sym:'O',x:L*1.5,y:L*0.866},
      {idx:5,sym:'C',x:0,y:-L},{idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'C',x:0,y:-L*2.732},{idx:8,sym:'C',x:L*0.5,y:-L*3.598},
      {idx:9,sym:'N',x:0,y:-L*4.464},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:1},{i:8,j:9,order:1}]
  }),

  'histidine': L => {
    const imid = mkRing(5,['N','C','N','C','C'],L*0.5,-L*2,L*0.851,-Math.PI/2,true);
    const backbone = {
      atoms:[
        {idx:10,sym:'N',x:-L,y:0},{idx:11,sym:'C',x:0,y:0},
        {idx:12,sym:'C',x:L,y:0},{idx:13,sym:'O',x:L*1.5,y:-L*0.866},
        {idx:14,sym:'O',x:L*1.5,y:L*0.866},{idx:15,sym:'C',x:0,y:-L},
      ],
      bonds:[{i:10,j:11,order:1},{i:11,j:12,order:1},{i:12,j:13,order:2},{i:12,j:14,order:1},
             {i:11,j:15,order:1}]
    };
    return {atoms:[...imid.atoms,...backbone.atoms],
            bonds:[...imid.bonds,...backbone.bonds,{i:15,j:4,order:1}]};
  },

  'proline': L => {
    const ringA=[
      {idx:0,sym:'N',x:0,y:0},{idx:1,sym:'C',x:L,y:0},
      {idx:2,sym:'C',x:L*1.5,y:-L*0.866},{idx:3,sym:'C',x:L,y:-L*1.732},
      {idx:4,sym:'C',x:0,y:-L*1.732},
    ];
    return {
      atoms:[
        ...ringA,
        {idx:5,sym:'C',x:L*2,y:0},{idx:6,sym:'O',x:L*2.5,y:-L*0.866},
        {idx:7,sym:'O',x:L*2.5,y:L*0.866},
      ],
      bonds:[
        {i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:1},{i:3,j:4,order:1},{i:4,j:0,order:1},
        {i:1,j:5,order:1},{i:5,j:6,order:2},{i:5,j:7,order:1},
      ]
    };
  },

  'methionine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'C',x:L,y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},{idx:4,sym:'O',x:L*1.5,y:L*0.866},
      {idx:5,sym:'C',x:0,y:-L},{idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'S',x:0,y:-L*2.732},{idx:8,sym:'C',x:L*0.5,y:-L*3.598},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:1}]
  }),

  // ── Sugars ───────────────────────────────────────────────────
  'glucose': L => {
    // β-D-glucopyranose (ring form)
    const H=L*0.866;
    // 6-membered ring with O
    const syms=['O','C','C','C','C','C'];
    const ring=mkRing(6,syms,0,0,L,-Math.PI/2,false);
    // Add OH groups and CH2OH
    const extra=[
      {idx:6,sym:'O',x:ring.atoms[1].x+H,y:ring.atoms[1].y},   // C1-OH
      {idx:7,sym:'O',x:ring.atoms[2].x+H,y:ring.atoms[2].y},   // C2-OH
      {idx:8,sym:'O',x:ring.atoms[3].x-H,y:ring.atoms[3].y},   // C3-OH
      {idx:9,sym:'O',x:ring.atoms[4].x-H,y:ring.atoms[4].y},   // C4-OH
      {idx:10,sym:'C',x:ring.atoms[5].x+H,y:ring.atoms[5].y},  // C6 (CH2OH)
      {idx:11,sym:'O',x:ring.atoms[5].x+2*H,y:ring.atoms[5].y},// C6-OH
    ];
    const xbonds=[
      {i:1,j:6,order:1},{i:2,j:7,order:1},{i:3,j:8,order:1},
      {i:4,j:9,order:1},{i:5,j:10,order:1},{i:10,j:11,order:1},
    ];
    return {atoms:[...ring.atoms,...extra], bonds:[...ring.bonds,...xbonds]};
  },

  'ribose': L => {
    // β-D-ribofuranose
    const H=L*0.866;
    const syms=['O','C','C','C','C'];
    const ring=mkRing(5,syms,0,0,L*0.851,-Math.PI/2,false);
    const extra=[
      {idx:5,sym:'O',x:ring.atoms[1].x+H,y:ring.atoms[1].y},
      {idx:6,sym:'O',x:ring.atoms[2].x+H,y:ring.atoms[2].y},
      {idx:7,sym:'O',x:ring.atoms[3].x-H,y:ring.atoms[3].y},
      {idx:8,sym:'C',x:ring.atoms[4].x+H,y:ring.atoms[4].y},
      {idx:9,sym:'O',x:ring.atoms[4].x+2*H,y:ring.atoms[4].y},
    ];
    return {atoms:[...ring.atoms,...extra],
            bonds:[...ring.bonds,{i:1,j:5,order:1},{i:2,j:6,order:1},{i:3,j:7,order:1},{i:4,j:8,order:1},{i:8,j:9,order:1}]};
  },

  // ── Cofactors ─────────────────────────────────────────────────
  // AMP = adenine + ribose + 1 phosphate
  'AMP': L => {
    const ad=TEMPLATES['adenine'](L);
    // shift adenine up
    ad.atoms.forEach(a=>{a.y-=L*2;});
    const N9=ad.atoms.find(a=>a.sym==='N'&&a.idx===8); // N9
    const rb={
      atoms:[
        {idx:20,sym:'C',x:N9?N9.x:0,y:N9?N9.y+L:0},
        {idx:21,sym:'C',x:N9?N9.x+L*0.5:L*0.5,y:N9?N9.y+L*1.866:L*1.866},
        {idx:22,sym:'O',x:N9?N9.x+L*1.5:L*1.5,y:N9?N9.y+L*1.866:L*1.866},
        {idx:23,sym:'C',x:N9?N9.x+L:L,y:N9?N9.y+L*2.732:L*2.732},
        {idx:24,sym:'C',x:N9?N9.x:0,y:N9?N9.y+L*2.732:L*2.732},
        // phosphate
        {idx:25,sym:'P',x:N9?N9.x-L:0-L,y:N9?N9.y+L*2.732:L*2.732},
        {idx:26,sym:'O',x:N9?N9.x-L*1.5:0-L*1.5,y:N9?N9.y+L*1.866:L*1.866},
        {idx:27,sym:'O',x:N9?N9.x-L*2:0-L*2,y:N9?N9.y+L*2.732:L*2.732},
        {idx:28,sym:'O',x:N9?N9.x-L*1.5:0-L*1.5,y:N9?N9.y+L*3.598:L*3.598},
      ],
      bonds:[
        {i:8,j:20,order:1},  // N9-C1'
        {i:20,j:21,order:1},{i:21,j:22,order:1},{i:22,j:23,order:1},
        {i:23,j:24,order:1},{i:24,j:20,order:1},
        {i:24,j:25,order:1},{i:25,j:26,order:2},{i:25,j:27,order:1},{i:25,j:28,order:1},
      ]
    };
    return {atoms:[...ad.atoms,...rb.atoms], bonds:[...ad.bonds,...rb.bonds]};
  },

  // ATP simplified: adenine + ribose + 3 phosphates in a chain
  'ATP': L => {
    const ad=TEMPLATES['adenine'](L);
    ad.atoms.forEach(a=>{a.y-=L*3;});
    const base_y = (ad.atoms.find(a=>a.idx===8)||{y:0}).y;
    const base_x = (ad.atoms.find(a=>a.idx===8)||{x:0}).x;
    return {
      atoms:[
        ...ad.atoms,
        // ribose sugar (simplified)
        {idx:20,sym:'C',x:base_x,     y:base_y+L},
        {idx:21,sym:'C',x:base_x+L*0.5,y:base_y+L*1.866},
        {idx:22,sym:'O',x:base_x+L*1.5,y:base_y+L*1.866},
        {idx:23,sym:'C',x:base_x+L,   y:base_y+L*2.732},
        {idx:24,sym:'C',x:base_x,     y:base_y+L*2.732},
        {idx:25,sym:'O',x:base_x-L*0.5,y:base_y+L*3.6},
        // α-phosphate
        {idx:30,sym:'P',x:base_x-L*1.5,y:base_y+L*3.6},
        {idx:31,sym:'O',x:base_x-L*1.5,y:base_y+L*4.5},
        {idx:32,sym:'O',x:base_x-L*2.4,y:base_y+L*3.1},
        // β-phosphate
        {idx:33,sym:'P',x:base_x-L*2.5,y:base_y+L*3.6},
        {idx:34,sym:'O',x:base_x-L*2.5,y:base_y+L*4.5},
        {idx:35,sym:'O',x:base_x-L*3.4,y:base_y+L*3.1},
        // γ-phosphate
        {idx:36,sym:'P',x:base_x-L*3.5,y:base_y+L*3.6},
        {idx:37,sym:'O',x:base_x-L*3.5,y:base_y+L*4.5},
        {idx:38,sym:'O',x:base_x-L*4.4,y:base_y+L*3.1},
        {idx:39,sym:'O',x:base_x-L*3.5,y:base_y+L*2.7},
      ],
      bonds:[
        ...ad.bonds,
        {i:8,j:20,order:1},{i:20,j:21,order:1},{i:21,j:22,order:1},
        {i:22,j:23,order:1},{i:23,j:24,order:1},{i:24,j:20,order:1},
        {i:24,j:25,order:1},
        {i:25,j:30,order:1},{i:30,j:31,order:2},{i:30,j:32,order:1},
        {i:30,j:33,order:1},{i:33,j:34,order:2},{i:33,j:35,order:1},
        {i:33,j:36,order:1},{i:36,j:37,order:2},{i:36,j:38,order:1},{i:36,j:39,order:1},
      ]
    };
  },

  'ADP': L => {
    const ad=TEMPLATES['adenine'](L);
    ad.atoms.forEach(a=>{a.y-=L*3;});
    const base_y=(ad.atoms.find(a=>a.idx===8)||{y:0}).y;
    const base_x=(ad.atoms.find(a=>a.idx===8)||{x:0}).x;
    return {
      atoms:[
        ...ad.atoms,
        {idx:20,sym:'C',x:base_x,     y:base_y+L},
        {idx:21,sym:'C',x:base_x+L*0.5,y:base_y+L*1.866},
        {idx:22,sym:'O',x:base_x+L*1.5,y:base_y+L*1.866},
        {idx:23,sym:'C',x:base_x+L,   y:base_y+L*2.732},
        {idx:24,sym:'C',x:base_x,     y:base_y+L*2.732},
        {idx:25,sym:'O',x:base_x-L*0.5,y:base_y+L*3.6},
        {idx:30,sym:'P',x:base_x-L*1.5,y:base_y+L*3.6},
        {idx:31,sym:'O',x:base_x-L*1.5,y:base_y+L*4.5},
        {idx:32,sym:'O',x:base_x-L*2.4,y:base_y+L*3.1},
        {idx:33,sym:'P',x:base_x-L*2.5,y:base_y+L*3.6},
        {idx:34,sym:'O',x:base_x-L*2.5,y:base_y+L*4.5},
        {idx:35,sym:'O',x:base_x-L*3.4,y:base_y+L*3.1},
        {idx:36,sym:'O',x:base_x-L*2.5,y:base_y+L*2.7},
      ],
      bonds:[
        ...ad.bonds,
        {i:8,j:20,order:1},{i:20,j:21,order:1},{i:21,j:22,order:1},
        {i:22,j:23,order:1},{i:23,j:24,order:1},{i:24,j:20,order:1},
        {i:24,j:25,order:1},
        {i:25,j:30,order:1},{i:30,j:31,order:2},{i:30,j:32,order:1},
        {i:30,j:33,order:1},{i:33,j:34,order:2},{i:33,j:35,order:1},{i:33,j:36,order:1},
      ]
    };
  },

  // ── Additional fused/polycyclic ─────────────────────────────
  'phenanthrene': L => {
    const H=L*0.866;
    // three fused rings in angular arrangement
    const atoms=[
      {idx:0,sym:'C',x:0,    y:-L/2},{idx:1,sym:'C',x:0,    y: L/2},
      {idx:2,sym:'C',x:-H,   y:-L},  {idx:3,sym:'C',x:-2*H, y:-L/2},
      {idx:4,sym:'C',x:-2*H, y: L/2},{idx:5,sym:'C',x:-H,   y: L},
      {idx:6,sym:'C',x: H,   y:-L},  {idx:7,sym:'C',x: 2*H, y:-L/2},
      {idx:8,sym:'C',x: 2*H, y: L/2},{idx:9,sym:'C',x: H,   y: L},
      // third ring fused at 7-8
      {idx:10,sym:'C',x:3*H,   y:-L},{idx:11,sym:'C',x:4*H, y:-L/2},
      {idx:12,sym:'C',x:4*H,   y: L/2},{idx:13,sym:'C',x:3*H,y: L},
    ];
    return {atoms, bonds:[
      {i:0,j:1,order:1},
      {i:0,j:2,order:2},{i:2,j:3,order:1},{i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:1,order:2},
      {i:0,j:6,order:2},{i:6,j:7,order:1},{i:7,j:8,order:2},{i:8,j:9,order:1},{i:9,j:1,order:2},
      {i:7,j:10,order:1},{i:10,j:11,order:2},{i:11,j:12,order:1},{i:12,j:13,order:2},{i:13,j:8,order:1},
    ]};
  },

  'azulene': L => {
    // 7-membered + 5-membered fused ring
    const R7=L/(2*Math.sin(Math.PI/7));
    const R5=L*0.851;
    const a7=[], a5=[];
    for(let i=0;i<7;i++){const a=-Math.PI/2+i*2*Math.PI/7;a7.push({x:Math.cos(a)*R7,y:Math.sin(a)*R7});}
    // shared bond: atoms 0 and 1 of 7-ring = atoms 3 and 2 of 5-ring
    // place 5-ring sharing bond between a7[0] and a7[6]
    const mx=(a7[0].x+a7[6].x)/2, my=(a7[0].y+a7[6].y)/2;
    const dx=a7[0].x-a7[6].x, dy=a7[0].y-a7[6].y, len=Math.hypot(dx,dy);
    const nx=-dy/len, ny=dx/len;
    const apm=R5*Math.cos(Math.PI/5);
    const c5x=mx+nx*apm, c5y=my+ny*apm;
    for(let i=0;i<5;i++){const a=-Math.PI/2+i*2*Math.PI/5;a5.push({x:c5x+Math.cos(a)*R5,y:c5y+Math.sin(a)*R5});}
    const atoms=[
      ...a7.map((p,i)=>({idx:i,sym:'C',x:p.x,y:p.y})),
      // a5[0]≈a7[0], a5[4]≈a7[6]; add a5[1..3]
      {idx:7,sym:'C',x:a5[1].x,y:a5[1].y},
      {idx:8,sym:'C',x:a5[2].x,y:a5[2].y},
      {idx:9,sym:'C',x:a5[3].x,y:a5[3].y},
    ];
    return {atoms,bonds:[
      {i:0,j:1,order:2},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:3,j:4,order:1},
      {i:4,j:5,order:2},{i:5,j:6,order:1},{i:6,j:0,order:2},
      {i:0,j:7,order:1},{i:7,j:8,order:2},{i:8,j:9,order:1},{i:9,j:6,order:1},
    ]};
  },

  'adamantane': L => {
    // adamantane: cage structure drawn in 2D projection
    const H=L*0.866;
    return {atoms:[
      {idx:0,sym:'C',x:0,    y:-L*1.2},
      {idx:1,sym:'C',x:-H,   y:-L*0.2},
      {idx:2,sym:'C',x: H,   y:-L*0.2},
      {idx:3,sym:'C',x:0,    y: L*0.6},
      {idx:4,sym:'C',x:-H*2, y: L*0.8},
      {idx:5,sym:'C',x: H*2, y: L*0.8},
      {idx:6,sym:'C',x:0,    y: L*1.8},
      {idx:7,sym:'C',x:-H,   y: L*2.5},
      {idx:8,sym:'C',x: H,   y: L*2.5},
      {idx:9,sym:'C',x:0,    y: L*3.2},
    ],bonds:[
      {i:0,j:1,order:1},{i:0,j:2,order:1},{i:1,j:3,order:1},{i:2,j:3,order:1},
      {i:1,j:4,order:1},{i:2,j:5,order:1},{i:3,j:6,order:1},
      {i:4,j:7,order:1},{i:5,j:8,order:1},{i:6,j:7,order:1},{i:6,j:8,order:1},
      {i:7,j:9,order:1},{i:8,j:9,order:1},
    ]};
  },

  // ── More heterocycles ────────────────────────────────────────
  'pyridazine': L => mkRing(6,['N','N','C','C','C','C'],0,0,L,-Math.PI/2,true),
  'triazine':   L => mkRing(6,['N','C','N','C','N','C'],0,0,L,-Math.PI/2,true),
  'isoxazole':  L => mkRing(5,['O','N','C','C','C'],0,0,L*0.851,-Math.PI/2,true),
  'thiazole':   L => mkRing(5,['S','C','N','C','C'],0,0,L*0.851,-Math.PI/2,true),

  'benzimidazole': L => {
    const H=L*0.866;
    const atoms=[
      {idx:0,sym:'C',x:0,   y:-L/2},{idx:1,sym:'C',x:0,   y: L/2},
      {idx:2,sym:'C',x:-H,  y:-L},  {idx:3,sym:'C',x:-2*H,y:-L/2},
      {idx:4,sym:'C',x:-2*H,y: L/2},{idx:5,sym:'C',x:-H,  y: L},
      {idx:6,sym:'N',x: H,  y:-L},  {idx:7,sym:'C',x: 2*H,y: 0},
      {idx:8,sym:'N',x: H,  y: L},
    ];
    return {atoms,bonds:[
      {i:0,j:1,order:1},
      {i:0,j:2,order:2},{i:2,j:3,order:1},{i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:1,order:2},
      {i:0,j:6,order:1},{i:6,j:7,order:2},{i:7,j:8,order:1},{i:8,j:1,order:1},
    ]};
  },

  'quinoline': L => {
    const H=L*0.866;
    const atoms=[
      {idx:0,sym:'C',x:0,   y:-L/2},{idx:1,sym:'C',x:0,   y: L/2},
      {idx:2,sym:'C',x:-H,  y:-L},  {idx:3,sym:'C',x:-2*H,y:-L/2},
      {idx:4,sym:'C',x:-2*H,y: L/2},{idx:5,sym:'C',x:-H,  y: L},
      {idx:6,sym:'C',x: H,  y:-L},  {idx:7,sym:'N',x: 2*H,y:-L/2},
      {idx:8,sym:'C',x: 2*H,y: L/2},{idx:9,sym:'C',x: H,  y: L},
    ];
    return {atoms,bonds:[
      {i:0,j:1,order:1},
      {i:0,j:2,order:2},{i:2,j:3,order:1},{i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:1,order:2},
      {i:0,j:6,order:2},{i:6,j:7,order:1},{i:7,j:8,order:2},{i:8,j:9,order:1},{i:9,j:1,order:2},
    ]};
  },

  'isoquinoline': L => {
    const H=L*0.866;
    const atoms=[
      {idx:0,sym:'C',x:0,   y:-L/2},{idx:1,sym:'C',x:0,   y: L/2},
      {idx:2,sym:'C',x:-H,  y:-L},  {idx:3,sym:'C',x:-2*H,y:-L/2},
      {idx:4,sym:'C',x:-2*H,y: L/2},{idx:5,sym:'C',x:-H,  y: L},
      {idx:6,sym:'N',x: H,  y:-L},  {idx:7,sym:'C',x: 2*H,y:-L/2},
      {idx:8,sym:'C',x: 2*H,y: L/2},{idx:9,sym:'C',x: H,  y: L},
    ];
    return {atoms,bonds:[
      {i:0,j:1,order:1},
      {i:0,j:2,order:2},{i:2,j:3,order:1},{i:3,j:4,order:2},{i:4,j:5,order:1},{i:5,j:1,order:2},
      {i:0,j:6,order:1},{i:6,j:7,order:2},{i:7,j:8,order:1},{i:8,j:9,order:2},{i:9,j:1,order:1},
    ]};
  },

  'purine': L => {
    const s=L;
    return {atoms:[
      {idx:0,sym:'N',x:-s,      y:0},
      {idx:1,sym:'C',x:-s*0.5,  y:s*0.866},
      {idx:2,sym:'N',x: s*0.5,  y:s*0.866},
      {idx:3,sym:'C',x: s,      y:0},
      {idx:4,sym:'C',x: s*0.5,  y:-s*0.866},
      {idx:5,sym:'C',x:-s*0.5,  y:-s*0.866},
      {idx:6,sym:'N',x: s*1.978,y:-s*0.207},
      {idx:7,sym:'C',x: s*2.083,y:-s*1.203},
      {idx:8,sym:'N',x: s*1.169,y:-s*1.609},
    ],bonds:[
      {i:0,j:1,order:2},{i:1,j:2,order:1},{i:2,j:3,order:2},
      {i:3,j:4,order:1},{i:4,j:5,order:2},{i:5,j:0,order:1},
      {i:3,j:6,order:1},{i:6,j:7,order:2},{i:7,j:8,order:1},{i:8,j:4,order:1},
    ]};
  },

  'porphyrin': L => {
    // Simplified porphyrin: 4 pyrrole rings connected by methine bridges around a center
    const R=L*2.5;
    const atoms=[], bonds=[];
    let idx=0;
    const pyrroleAngles=[0,Math.PI/2,Math.PI,3*Math.PI/2]; // 4 positions
    const bridgeN=[];
    pyrroleAngles.forEach((pa,pi)=>{
      const cx=Math.cos(pa)*R, cy=Math.sin(pa)*R;
      // pyrrole N at center of each unit
      atoms.push({idx:idx,sym:'N',x:cx,y:cy});
      const ni=idx++;
      // 4 C atoms around each N
      for(let i=0;i<4;i++){
        const a=pa+(-0.6+i*0.4);
        atoms.push({idx:idx,sym:'C',x:cx+Math.cos(a)*L,y:cy+Math.sin(a)*L});
        idx++;
      }
      bridgeN.push(ni);
    });
    // internal bonds for each pyrrole: N + 4 C in ring
    for(let pi=0;pi<4;pi++){
      const base=pi*5;
      bonds.push({i:base,j:base+1,order:1},{i:base+1,j:base+2,order:2},
                 {i:base+2,j:base,order:1},{i:base,j:base+3,order:1},
                 {i:base+3,j:base+4,order:2},{i:base+4,j:base,order:1});
    }
    // methine bridges between pyrroles: C4 of ring0 to C1 of ring1, etc.
    // (outermost C of each ring toward next ring)
    // skip detailed bridge atoms for simplicity; use meso bridge carbons
    const mesoCx=[Math.cos(Math.PI/4)*R,Math.cos(3*Math.PI/4)*R,Math.cos(5*Math.PI/4)*R,Math.cos(7*Math.PI/4)*R];
    const mesoCy=[Math.sin(Math.PI/4)*R,Math.sin(3*Math.PI/4)*R,Math.sin(5*Math.PI/4)*R,Math.sin(7*Math.PI/4)*R];
    mesoCx.forEach((mx,mi)=>{
      atoms.push({idx:idx,sym:'C',x:mx,y:mesoCy[mi]});
      idx++;
    });
    // connect meso C to adjacent pyrrole outer C
    // pyrrole 0 outer C = idx 4 (base+4) and base+2; meso at idx 20,21,22,23
    bonds.push(
      {i:4, j:20,order:1},{i:20,j:6, order:1},
      {i:9, j:21,order:1},{i:21,j:11,order:1},
      {i:14,j:22,order:1},{i:22,j:16,order:1},
      {i:19,j:23,order:1},{i:23,j:1, order:1},
    );
    return {atoms,bonds};
  },

  // ── Remaining amino acids ────────────────────────────────────
  'leucine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'C',x:L,y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},{idx:4,sym:'O',x:L*1.5,y:L*0.866},
      {idx:5,sym:'C',x:0,y:-L},{idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'C',x:0,y:-L*2.732},{idx:8,sym:'C',x:L,y:-L*2.732},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:1},{i:6,j:8,order:1}]
  }),

  'isoleucine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'C',x:L,y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},{idx:4,sym:'O',x:L*1.5,y:L*0.866},
      {idx:5,sym:'C',x:0,y:-L},{idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'C',x:0,y:-L*2.732},{idx:8,sym:'C',x:L,y:-L},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:1},{i:5,j:8,order:1}]
  }),

  'threonine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'C',x:L,y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},{idx:4,sym:'O',x:L*1.5,y:L*0.866},
      {idx:5,sym:'C',x:0,y:-L},{idx:6,sym:'O',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'C',x:-L*0.5,y:-L*1.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:5,j:7,order:1}]
  }),

  'asparagine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'C',x:L,y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},{idx:4,sym:'O',x:L*1.5,y:L*0.866},
      {idx:5,sym:'C',x:0,y:-L},{idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'O',x:L*1.5,y:-L*1.866},{idx:8,sym:'N',x:0,y:-L*2.732},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:2},{i:6,j:8,order:1}]
  }),

  'glutamine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'C',x:L,y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},{idx:4,sym:'O',x:L*1.5,y:L*0.866},
      {idx:5,sym:'C',x:0,y:-L},{idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'C',x:0,y:-L*2.732},{idx:8,sym:'O',x:L,y:-L*2.732},{idx:9,sym:'N',x:-L*0.5,y:-L*3.598},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:2},{i:7,j:9,order:1}]
  }),

  'arginine': L => ({
    atoms:[
      {idx:0,sym:'N',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'C',x:L,y:0},
      {idx:3,sym:'O',x:L*1.5,y:-L*0.866},{idx:4,sym:'O',x:L*1.5,y:L*0.866},
      {idx:5,sym:'C',x:0,y:-L},{idx:6,sym:'C',x:L*0.5,y:-L*1.866},
      {idx:7,sym:'C',x:0,y:-L*2.732},{idx:8,sym:'N',x:L*0.5,y:-L*3.598},
      {idx:9,sym:'C',x:0,y:-L*4.464},{idx:10,sym:'N',x:L,y:-L*4.464},
      {idx:11,sym:'N',x:-L*0.5,y:-L*5.33},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:2,j:4,order:1},
           {i:1,j:5,order:1},{i:5,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:1},
           {i:8,j:9,order:1},{i:9,j:10,order:1},{i:9,j:11,order:2}]
  }),

  // ── More sugars ──────────────────────────────────────────────
  'galactose': L => {
    const H=L*0.866;
    const syms=['O','C','C','C','C','C'];
    const ring=mkRing(6,syms,0,0,L,-Math.PI/2,false);
    const extra=[
      {idx:6,sym:'O',x:ring.atoms[1].x+H,y:ring.atoms[1].y},
      {idx:7,sym:'O',x:ring.atoms[2].x-H,y:ring.atoms[2].y}, // axial OH at C2 differs from glucose
      {idx:8,sym:'O',x:ring.atoms[3].x-H,y:ring.atoms[3].y},
      {idx:9,sym:'O',x:ring.atoms[4].x+H,y:ring.atoms[4].y}, // axial OH at C4 (galactose)
      {idx:10,sym:'C',x:ring.atoms[5].x+H,y:ring.atoms[5].y},
      {idx:11,sym:'O',x:ring.atoms[5].x+2*H,y:ring.atoms[5].y},
    ];
    return {atoms:[...ring.atoms,...extra],
            bonds:[...ring.bonds,{i:1,j:6,order:1},{i:2,j:7,order:1},{i:3,j:8,order:1},
                   {i:4,j:9,order:1},{i:5,j:10,order:1},{i:10,j:11,order:1}]};
  },

  'fructose': L => {
    // β-D-fructofuranose
    const H=L*0.866;
    const syms=['O','C','C','C','C'];
    const ring=mkRing(5,syms,0,0,L*0.851,-Math.PI/2,false);
    const extra=[
      {idx:5,sym:'C',x:ring.atoms[1].x-H,y:ring.atoms[1].y},
      {idx:6,sym:'O',x:ring.atoms[1].x-2*H,y:ring.atoms[1].y},
      {idx:7,sym:'O',x:ring.atoms[2].x+H,y:ring.atoms[2].y},
      {idx:8,sym:'O',x:ring.atoms[3].x-H,y:ring.atoms[3].y},
      {idx:9,sym:'C',x:ring.atoms[4].x+H,y:ring.atoms[4].y},
      {idx:10,sym:'O',x:ring.atoms[4].x+2*H,y:ring.atoms[4].y},
    ];
    return {atoms:[...ring.atoms,...extra],
            bonds:[...ring.bonds,{i:1,j:5,order:1},{i:5,j:6,order:1},{i:2,j:7,order:1},
                   {i:3,j:8,order:1},{i:4,j:9,order:1},{i:9,j:10,order:1}]};
  },

  'mannose': L => {
    const H=L*0.866;
    const syms=['O','C','C','C','C','C'];
    const ring=mkRing(6,syms,0,0,L,-Math.PI/2,false);
    const extra=[
      {idx:6,sym:'O',x:ring.atoms[1].x+H,y:ring.atoms[1].y},
      {idx:7,sym:'O',x:ring.atoms[2].x+H,y:ring.atoms[2].y}, // axial at C2
      {idx:8,sym:'O',x:ring.atoms[3].x-H,y:ring.atoms[3].y},
      {idx:9,sym:'O',x:ring.atoms[4].x-H,y:ring.atoms[4].y},
      {idx:10,sym:'C',x:ring.atoms[5].x+H,y:ring.atoms[5].y},
      {idx:11,sym:'O',x:ring.atoms[5].x+2*H,y:ring.atoms[5].y},
    ];
    return {atoms:[...ring.atoms,...extra],
            bonds:[...ring.bonds,{i:1,j:6,order:1},{i:2,j:7,order:1},{i:3,j:8,order:1},
                   {i:4,j:9,order:1},{i:5,j:10,order:1},{i:10,j:11,order:1}]};
  },

  'deoxyribose': L => {
    const H=L*0.866;
    const syms=['O','C','C','C','C'];
    const ring=mkRing(5,syms,0,0,L*0.851,-Math.PI/2,false);
    const extra=[
      // C2 has no OH (deoxy)
      {idx:5,sym:'O',x:ring.atoms[2].x+H,y:ring.atoms[2].y}, // C3-OH
      {idx:6,sym:'C',x:ring.atoms[4].x+H,y:ring.atoms[4].y},
      {idx:7,sym:'O',x:ring.atoms[4].x+2*H,y:ring.atoms[4].y},
    ];
    return {atoms:[...ring.atoms,...extra],
            bonds:[...ring.bonds,{i:2,j:5,order:1},{i:4,j:6,order:1},{i:6,j:7,order:1}]};
  },

  'glucosamine': L => {
    const H=L*0.866;
    const syms=['O','C','C','C','C','C'];
    const ring=mkRing(6,syms,0,0,L,-Math.PI/2,false);
    const extra=[
      {idx:6,sym:'O',x:ring.atoms[1].x+H,y:ring.atoms[1].y},
      {idx:7,sym:'N',x:ring.atoms[2].x+H,y:ring.atoms[2].y}, // NH2 at C2
      {idx:8,sym:'O',x:ring.atoms[3].x-H,y:ring.atoms[3].y},
      {idx:9,sym:'O',x:ring.atoms[4].x-H,y:ring.atoms[4].y},
      {idx:10,sym:'C',x:ring.atoms[5].x+H,y:ring.atoms[5].y},
      {idx:11,sym:'O',x:ring.atoms[5].x+2*H,y:ring.atoms[5].y},
    ];
    return {atoms:[...ring.atoms,...extra],
            bonds:[...ring.bonds,{i:1,j:6,order:1},{i:2,j:7,order:1},{i:3,j:8,order:1},
                   {i:4,j:9,order:1},{i:5,j:10,order:1},{i:10,j:11,order:1}]};
  },

  'glucuronic': L => {
    const H=L*0.866;
    const syms=['O','C','C','C','C','C'];
    const ring=mkRing(6,syms,0,0,L,-Math.PI/2,false);
    const extra=[
      {idx:6,sym:'O',x:ring.atoms[1].x+H,y:ring.atoms[1].y},
      {idx:7,sym:'O',x:ring.atoms[2].x+H,y:ring.atoms[2].y},
      {idx:8,sym:'O',x:ring.atoms[3].x-H,y:ring.atoms[3].y},
      {idx:9,sym:'O',x:ring.atoms[4].x-H,y:ring.atoms[4].y},
      // C6 → COOH instead of CH2OH
      {idx:10,sym:'C',x:ring.atoms[5].x+H,y:ring.atoms[5].y},
      {idx:11,sym:'O',x:ring.atoms[5].x+2*H,y:ring.atoms[5].y-H},
      {idx:12,sym:'O',x:ring.atoms[5].x+2*H,y:ring.atoms[5].y+H},
    ];
    return {atoms:[...ring.atoms,...extra],
            bonds:[...ring.bonds,{i:1,j:6,order:1},{i:2,j:7,order:1},{i:3,j:8,order:1},
                   {i:4,j:9,order:1},{i:5,j:10,order:1},{i:10,j:11,order:2},{i:10,j:12,order:1}]};
  },

  // ── Cofactors ────────────────────────────────────────────────
  'GTP': L => {
    const gu=TEMPLATES['guanine'](L);
    gu.atoms.forEach(a=>{a.y-=L*3;});
    const base_y=(gu.atoms.find(a=>a.idx===8)||{y:0}).y;
    const base_x=(gu.atoms.find(a=>a.idx===8)||{x:0}).x;
    return {
      atoms:[...gu.atoms,
        {idx:20,sym:'C',x:base_x,     y:base_y+L},
        {idx:21,sym:'C',x:base_x+L*0.5,y:base_y+L*1.866},
        {idx:22,sym:'O',x:base_x+L*1.5,y:base_y+L*1.866},
        {idx:23,sym:'C',x:base_x+L,   y:base_y+L*2.732},
        {idx:24,sym:'C',x:base_x,     y:base_y+L*2.732},
        {idx:25,sym:'O',x:base_x-L*0.5,y:base_y+L*3.6},
        {idx:30,sym:'P',x:base_x-L*1.5,y:base_y+L*3.6},
        {idx:31,sym:'O',x:base_x-L*1.5,y:base_y+L*4.5},
        {idx:32,sym:'O',x:base_x-L*2.4,y:base_y+L*3.1},
        {idx:33,sym:'P',x:base_x-L*2.5,y:base_y+L*3.6},
        {idx:34,sym:'O',x:base_x-L*2.5,y:base_y+L*4.5},
        {idx:35,sym:'O',x:base_x-L*3.4,y:base_y+L*3.1},
        {idx:36,sym:'P',x:base_x-L*3.5,y:base_y+L*3.6},
        {idx:37,sym:'O',x:base_x-L*3.5,y:base_y+L*4.5},
        {idx:38,sym:'O',x:base_x-L*4.4,y:base_y+L*3.1},
        {idx:39,sym:'O',x:base_x-L*3.5,y:base_y+L*2.7},
      ],
      bonds:[...gu.bonds,
        {i:8,j:20,order:1},{i:20,j:21,order:1},{i:21,j:22,order:1},
        {i:22,j:23,order:1},{i:23,j:24,order:1},{i:24,j:20,order:1},
        {i:24,j:25,order:1},
        {i:25,j:30,order:1},{i:30,j:31,order:2},{i:30,j:32,order:1},
        {i:30,j:33,order:1},{i:33,j:34,order:2},{i:33,j:35,order:1},
        {i:33,j:36,order:1},{i:36,j:37,order:2},{i:36,j:38,order:1},{i:36,j:39,order:1},
      ]
    };
  },

  // NAD+ nicotinamide ring + adenine + 2 ribose + 2 phosphate
  'NAD': L => {
    const ad=TEMPLATES['adenine'](L);
    ad.atoms.forEach(a=>{a.x-=L*6; a.y-=L*2;});
    // Nicotinamide ring (pyridinium)
    const nic=mkRing(6,['N','C','C','C','C','C'],L*2,0,L,-Math.PI/2,true);
    // amide at C3
    const amide=[
      {idx:50,sym:'C',x:L*2+L*1.5,y:L*0.866},
      {idx:51,sym:'O',x:L*2+L*2.5,y:L*0.866},
      {idx:52,sym:'N',x:L*2+L*1.5,y:L*1.866},
    ];
    // phosphate bridge (simplified)
    const bridge=[
      {idx:60,sym:'P',x:-L*0.5,y:L*1.5},{idx:61,sym:'O',x:-L*0.5,y:L*2.5},
      {idx:62,sym:'O',x:-L*1.5,y:L*1.5},
      {idx:63,sym:'P',x: L*0.5,y:L*1.5},{idx:64,sym:'O',x: L*0.5,y:L*2.5},
      {idx:65,sym:'O',x: L*1.5,y:L*1.5},
    ];
    return {
      atoms:[...ad.atoms,...nic.atoms,...amide,...bridge],
      bonds:[...ad.bonds,...nic.bonds,
        {i:2,j:50,order:1},{i:50,j:51,order:2},{i:50,j:52,order:1},
        {i:60,j:61,order:2},{i:60,j:62,order:1},{i:60,j:63,order:1},
        {i:63,j:64,order:2},{i:63,j:65,order:1},
      ]
    };
  },

  'NADH': L => {
    // Same as NAD but nicotinamide ring is reduced (no + charge, different bond orders)
    const nad=TEMPLATES['NAD'](L);
    // Just label it the same; mark ring as reduced (all single bonds in nicotinamide)
    nad.bonds.forEach(b=>{
      const inNic=b.i>=6&&b.i<12&&b.j>=6&&b.j<12;
      if(inNic) b.order=1;
    });
    return nad;
  },

  // FAD: isoalloxazine + ribitol + AMP
  'FAD': L => {
    // Isoalloxazine ring system (simplified)
    const H=L*0.866;
    const isoAtoms=[
      // benzene ring part
      {idx:0,sym:'C',x:0,y:0},{idx:1,sym:'C',x:0,y:L},{idx:2,sym:'C',x:-H,y:L*1.5},
      {idx:3,sym:'C',x:-2*H,y:L},{idx:4,sym:'C',x:-2*H,y:0},{idx:5,sym:'C',x:-H,y:-L*0.5},
      // pyrimidine ring part
      {idx:6,sym:'N',x:H,y:-L*0.5},{idx:7,sym:'C',x:H*2,y:0},{idx:8,sym:'N',x:H*2,y:L},
      {idx:9,sym:'C',x:H,y:L*1.5},
      // middle ring
      {idx:10,sym:'O',x:H*3,y:-L*0.5},{idx:11,sym:'O',x:H*3,y:L*1.5},
      // ribitol chain
      {idx:12,sym:'N',x:0,y:-L},{idx:13,sym:'C',x:0,y:-L*2},{idx:14,sym:'C',x:L*0.5,y:-L*2.866},
      {idx:15,sym:'C',x:0,y:-L*3.732},{idx:16,sym:'C',x:L*0.5,y:-L*4.598},
      {idx:17,sym:'O',x:L*1.5,y:-L*2.866},{idx:18,sym:'O',x:L,y:-L*3.732},
      {idx:19,sym:'O',x:L*1.5,y:-L*4.598},
    ];
    return {atoms:isoAtoms,bonds:[
      {i:0,j:1,order:2},{i:1,j:2,order:1},{i:2,j:3,order:2},{i:3,j:4,order:1},{i:4,j:5,order:2},{i:5,j:0,order:1},
      {i:0,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:1},{i:8,j:9,order:1},{i:9,j:1,order:1},
      {i:7,j:10,order:2},{i:8,j:11,order:2},
      {i:5,j:12,order:1},{i:12,j:13,order:1},{i:13,j:14,order:1},{i:14,j:15,order:1},
      {i:15,j:16,order:1},{i:14,j:17,order:1},{i:15,j:18,order:1},{i:16,j:19,order:1},
    ]};
  },

  // CoA simplified: pantothenic acid + cysteamine + phosphate
  'CoA': L => ({
    atoms:[
      {idx:0,sym:'S',x:0,y:0},
      {idx:1,sym:'C',x:L,y:0},{idx:2,sym:'C',x:L*2,y:0},
      {idx:3,sym:'N',x:L*2.5,y:-L*0.866},
      {idx:4,sym:'C',x:L*3.5,y:-L*0.866},{idx:5,sym:'O',x:L*4,y:0},
      {idx:6,sym:'C',x:L*4,y:-L*1.732},{idx:7,sym:'C',x:L*5,y:-L*1.732},
      {idx:8,sym:'C',x:L*5,y:-L*0.732},{idx:9,sym:'N',x:L*5.5,y:L*0.134},
      {idx:10,sym:'C',x:L*6.5,y:L*0.134},
      {idx:11,sym:'O',x:L*7,y:-L*0.732},{idx:12,sym:'O',x:L*7,y:L},
      {idx:13,sym:'P',x:L*8,y:L*0.134},
      {idx:14,sym:'O',x:L*8,y:L*1.134},{idx:15,sym:'O',x:L*9,y:L*0.134},
      {idx:16,sym:'O',x:L*8,y:-L*0.866},
    ],
    bonds:[
      {i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:1},
      {i:3,j:4,order:1},{i:4,j:5,order:2},{i:4,j:6,order:1},
      {i:6,j:7,order:1},{i:7,j:8,order:1},{i:8,j:9,order:1},
      {i:9,j:10,order:1},{i:10,j:11,order:2},{i:10,j:12,order:1},
      {i:12,j:13,order:1},{i:13,j:14,order:2},{i:13,j:15,order:1},{i:13,j:16,order:1},
    ]
  }),

  'heme': L => {
    // Iron protoporphyrin IX — 4 pyrrole rings + Fe center
    const R=L*2.5, r=L*0.9;
    const atoms=[], bonds=[];
    let idx=0;
    // 4 N atoms for Fe coordination
    const Npos=[[0,-R],[R,0],[0,R],[-R,0]];
    const FeIdx=0;
    atoms.push({idx:idx++,sym:'Fe',x:0,y:0});
    Npos.forEach(([nx,ny])=>{
      const ni=idx;
      atoms.push({idx:idx++,sym:'N',x:nx,y:ny});
      bonds.push({i:FeIdx,j:ni,order:1});
      // 4 C atoms around each N
      const angle=Math.atan2(ny,nx);
      for(let i=0;i<4;i++){
        const a=angle+(-0.65+i*0.43);
        atoms.push({idx:idx++,sym:'C',x:nx+Math.cos(a)*r,y:ny+Math.sin(a)*r});
      }
    });
    // pyrrole ring bonds
    for(let pi=0;pi<4;pi++){
      const base=1+pi*5;
      const N=base, C1=base+1, C2=base+2, C3=base+3, C4=base+4;
      bonds.push({i:N,j:C1,order:1},{i:C1,j:C2,order:2},{i:C2,j:N,order:1},
                 {i:N,j:C3,order:1},{i:C3,j:C4,order:2},{i:C4,j:N,order:1});
    }
    // meso bridges between outer carbons of adjacent pyrroles
    const outer=[[3,6],[8,11],[13,16],[18,1+4]];
    outer.forEach(([a,b],i)=>{
      const mi=idx;
      const ax=atoms[a].x, ay=atoms[a].y, bx=atoms[b]?.x||atoms[1].x, by=atoms[b]?.y||atoms[1].y;
      atoms.push({idx:idx++,sym:'C',x:(ax+bx)/2,y:(ay+by)/2});
      bonds.push({i:a,j:mi,order:1},{i:mi,j:b||1,order:1});
    });
    return {atoms,bonds};
  },

  'cAMP': L => {
    // cyclic AMP: adenine + ribose with 3',5'-cyclic phosphate
    const ad=TEMPLATES['adenine'](L);
    ad.atoms.forEach(a=>{a.y-=L*3;});
    const N9=ad.atoms.find(a=>a.idx===8);
    const bx=N9?N9.x:0, by=N9?N9.y:0;
    return {
      atoms:[...ad.atoms,
        {idx:20,sym:'C',x:bx,       y:by+L},
        {idx:21,sym:'C',x:bx+L*0.5, y:by+L*1.866},
        {idx:22,sym:'O',x:bx+L*1.5, y:by+L*1.866},
        {idx:23,sym:'C',x:bx+L,     y:by+L*2.732},
        {idx:24,sym:'C',x:bx,       y:by+L*2.732},
        {idx:25,sym:'O',x:bx-L*0.5, y:by+L*3.6},
        {idx:26,sym:'P',x:bx-L*1.5, y:by+L*3.6},
        {idx:27,sym:'O',x:bx-L*1.5, y:by+L*4.5},
        {idx:28,sym:'O',x:bx+L*0.5, y:by+L*3.6}, // 5' O closing ring
      ],
      bonds:[...ad.bonds,
        {i:8,j:20,order:1},{i:20,j:21,order:1},{i:21,j:22,order:1},
        {i:22,j:23,order:1},{i:23,j:24,order:1},{i:24,j:20,order:1},
        // cyclic phosphate
        {i:24,j:25,order:1},{i:25,j:26,order:1},{i:26,j:27,order:2},
        {i:26,j:28,order:1},{i:28,j:22,order:1},
      ]
    };
  },

  // ── Lipids / Steroids ────────────────────────────────────────
  'steroid': L => {
    // Gonane skeleton: 3 cyclohexane + 1 cyclopentane fused
    const H=L*0.866;
    const atoms=[
      // Ring A (left hex)
      {idx:0,sym:'C',x:0,    y:-L/2},{idx:1,sym:'C',x:0,    y: L/2},
      {idx:2,sym:'C',x:-H,   y:-L},  {idx:3,sym:'C',x:-2*H, y:-L/2},
      {idx:4,sym:'C',x:-2*H, y: L/2},{idx:5,sym:'C',x:-H,   y: L},
      // Ring B (middle hex)
      {idx:6,sym:'C',x: H,   y:-L},  {idx:7,sym:'C',x: 2*H, y:-L/2},
      {idx:8,sym:'C',x: 2*H, y: L/2},{idx:9,sym:'C',x: H,   y: L},
      // Ring C (right hex)
      {idx:10,sym:'C',x: 3*H, y:-L},{idx:11,sym:'C',x: 4*H, y:-L/2},
      {idx:12,sym:'C',x: 4*H, y: L/2},{idx:13,sym:'C',x: 3*H, y: L},
      // Ring D (right pentagon fused to C)
      {idx:14,sym:'C',x: 5*H,   y: 0},
      {idx:15,sym:'C',x: 5*H+L*0.588, y:-L*0.809},
      {idx:16,sym:'C',x: 5*H+L*0.951, y: 0},
    ];
    return {atoms,bonds:[
      {i:0,j:1,order:1},
      {i:0,j:2,order:1},{i:2,j:3,order:1},{i:3,j:4,order:1},{i:4,j:5,order:1},{i:5,j:1,order:1},
      {i:0,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:1},{i:8,j:9,order:1},{i:9,j:1,order:1},
      {i:7,j:10,order:1},{i:10,j:11,order:1},{i:11,j:12,order:1},{i:12,j:13,order:1},{i:13,j:8,order:1},
      {i:11,j:14,order:1},{i:14,j:15,order:1},{i:15,j:16,order:1},{i:16,j:12,order:1},
    ]};
  },

  'cholesterol-ring': L => {
    const base=TEMPLATES['steroid'](L);
    // Add OH at C3 (atom 4) and double bond at C5-C6 (atoms 0-6)
    const extra=[{idx:20,sym:'O',x:base.atoms[4].x-L*0.866,y:base.atoms[4].y}];
    base.atoms.push(...extra);
    base.bonds.push({i:4,j:20,order:1});
    // make ring A/B junction double bond
    const b=base.bonds.find(b=>b.i===0&&b.j===6||b.i===6&&b.j===0);
    if(b) b.order=2;
    return base;
  },

  'fatty-acid': L => {
    // Palmitic acid (C16) as zig-zag chain
    const atoms=[], bonds=[];
    const n=16;
    for(let i=0;i<n;i++){
      const x=i*L*Math.cos(Math.PI/6), y=i%2===0?0:L*Math.sin(Math.PI/6);
      atoms.push({idx:i,sym:'C',x,y});
      if(i>0) bonds.push({i:i-1,j:i,order:1});
    }
    // carboxyl at C1 (idx 0)
    atoms.push({idx:n,sym:'O',x:-L*0.5,y:-L*0.866},{idx:n+1,sym:'O',x:-L*0.5,y:L*0.866});
    bonds.push({i:0,j:n,order:2},{i:0,j:n+1,order:1});
    return {atoms,bonds};
  },

  'glycerol': L => ({
    atoms:[
      {idx:0,sym:'C',x:0,y:0},{idx:1,sym:'C',x:0,y:-L},{idx:2,sym:'C',x:0,y:L},
      {idx:3,sym:'O',x:L,y:0},{idx:4,sym:'O',x:L,y:-L},{idx:5,sym:'O',x:L,y:L},
    ],
    bonds:[{i:0,j:1,order:1},{i:0,j:2,order:1},
           {i:0,j:3,order:1},{i:1,j:4,order:1},{i:2,j:5,order:1}]
  }),

  // ── More functional groups ───────────────────────────────────
  'ester': L => ({
    atoms:[
      {idx:0,sym:'C',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},
      {idx:2,sym:'O',x:L*0.5,y:-L*0.866},{idx:3,sym:'O',x:L*0.5,y:L*0.866},
      {idx:4,sym:'C',x:L*1.5,y:L*0.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:2},{i:1,j:3,order:1},{i:3,j:4,order:1}]
  }),

  'amide': L => ({
    atoms:[
      {idx:0,sym:'C',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},
      {idx:2,sym:'O',x:L*0.5,y:-L*0.866},{idx:3,sym:'N',x:L*0.5,y:L*0.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:2},{i:1,j:3,order:1}]
  }),

  'aldehyde': L => ({
    atoms:[{idx:0,sym:'C',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'O',x:L,y:0}],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:2}]
  }),

  'ketone': L => ({
    atoms:[{idx:0,sym:'C',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'O',x:0,y:-L},{idx:3,sym:'C',x:L,y:0}],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:2},{i:1,j:3,order:1}]
  }),

  'sulfonyl': L => ({
    atoms:[
      {idx:0,sym:'S',x:0,y:0},
      {idx:1,sym:'O',x:0,y:-L},{idx:2,sym:'O',x:0,y:L},
    ],
    bonds:[{i:0,j:1,order:2},{i:0,j:2,order:2}]
  }),

  'nitrile': L => ({
    atoms:[{idx:0,sym:'C',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},{idx:2,sym:'N',x:L,y:0}],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:3}]
  }),

  'nitro': L => ({
    atoms:[
      {idx:0,sym:'N',x:0,y:0},{idx:1,sym:'O',x:L*0.5,y:-L*0.866},{idx:2,sym:'O',x:L*0.5,y:L*0.866},
    ],
    bonds:[{i:0,j:1,order:2},{i:0,j:2,order:1}]
  }),

  'epoxide': L => ({
    atoms:[
      {idx:0,sym:'C',x:-L*0.5,y:0},{idx:1,sym:'C',x:L*0.5,y:0},{idx:2,sym:'O',x:0,y:-L*0.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:0,j:2,order:1},{i:1,j:2,order:1}]
  }),

  'lactam': L => ({
    // β-lactam (4-membered ring with N and C=O)
    atoms:[
      {idx:0,sym:'N',x:0,y:0},{idx:1,sym:'C',x:L,y:0},
      {idx:2,sym:'C',x:L,y:L},{idx:3,sym:'C',x:0,y:L},
      {idx:4,sym:'O',x:L*1.866,y:L*0.5},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:1},{i:3,j:0,order:1},{i:1,j:4,order:2}]
  }),

  // ── Drug / bioactive molecules ───────────────────────────────
  'aspirin': L => {
    const benz=mkRing(6,Array(6).fill('C'),0,0,L,-Math.PI/2,true);
    // C1: idx0 → OCOCH3 (acetyloxy)
    // C2: idx1 → COOH
    const extra=[
      {idx:6, sym:'O',x:benz.atoms[0].x+L*0.866,y:benz.atoms[0].y-L*0.5},
      {idx:7, sym:'C',x:benz.atoms[0].x+L*1.732,y:benz.atoms[0].y-L},
      {idx:8, sym:'O',x:benz.atoms[0].x+L*2.598,y:benz.atoms[0].y-L*0.5},
      {idx:9, sym:'C',x:benz.atoms[0].x+L*1.732,y:benz.atoms[0].y-L*2},
      // COOH at C2 (idx1)
      {idx:10,sym:'C',x:benz.atoms[1].x+L*0.866,y:benz.atoms[1].y-L*0.5},
      {idx:11,sym:'O',x:benz.atoms[1].x+L*1.732,y:benz.atoms[1].y},
      {idx:12,sym:'O',x:benz.atoms[1].x+L*1.732,y:benz.atoms[1].y-L},
    ];
    return {atoms:[...benz.atoms,...extra],bonds:[...benz.bonds,
      {i:0,j:6,order:1},{i:6,j:7,order:1},{i:7,j:8,order:2},{i:7,j:9,order:1},
      {i:1,j:10,order:1},{i:10,j:11,order:1},{i:10,j:12,order:2},
    ]};
  },

  'caffeine': L => {
    // 1,3,7-trimethylxanthine = methylated purine with two keto groups
    const s=L;
    return {atoms:[
      {idx:0,sym:'N',x:-s,      y:0},
      {idx:1,sym:'C',x:-s*0.5,  y:s*0.866},
      {idx:2,sym:'N',x: s*0.5,  y:s*0.866},
      {idx:3,sym:'C',x: s,      y:0},
      {idx:4,sym:'C',x: s*0.5,  y:-s*0.866},
      {idx:5,sym:'C',x:-s*0.5,  y:-s*0.866},
      {idx:6,sym:'N',x: s*1.978,y:-s*0.207},
      {idx:7,sym:'C',x: s*2.083,y:-s*1.203},
      {idx:8,sym:'N',x: s*1.169,y:-s*1.609},
      {idx:9,sym:'O',x:-s,      y:s*1.732},  // C2=O
      {idx:10,sym:'O',x:-s*0.5, y:-s*1.732}, // C6=O
      {idx:11,sym:'C',x:-s*2,   y:0},         // N1-CH3
      {idx:12,sym:'C',x: s*0.5, y:s*1.732},  // N3-CH3
      {idx:13,sym:'C',x: s*1.169,y:-s*2.609},// N7-CH3
    ],bonds:[
      {i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:1},
      {i:3,j:4,order:1},{i:4,j:5,order:1},{i:5,j:0,order:1},
      {i:3,j:6,order:1},{i:6,j:7,order:2},{i:7,j:8,order:1},{i:8,j:4,order:1},
      {i:1,j:9,order:2},{i:5,j:10,order:2},
      {i:0,j:11,order:1},{i:2,j:12,order:1},{i:6,j:13,order:1},
    ]};
  },

  'dopamine': L => {
    const benz=mkRing(6,Array(6).fill('C'),0,0,L,-Math.PI/2,true);
    // catechol: OH at C3(idx2) and C4(idx3)
    // side chain at C1(idx0): -CH2-CH2-NH2
    const H=L*0.866;
    const extra=[
      {idx:6,sym:'O',x:benz.atoms[2].x-H,y:benz.atoms[2].y},
      {idx:7,sym:'O',x:benz.atoms[3].x-H,y:benz.atoms[3].y},
      {idx:8,sym:'C',x:benz.atoms[0].x+H,y:benz.atoms[0].y-L*0.5},
      {idx:9,sym:'C',x:benz.atoms[0].x+2*H,y:benz.atoms[0].y-L},
      {idx:10,sym:'N',x:benz.atoms[0].x+3*H,y:benz.atoms[0].y-L*0.5},
    ];
    return {atoms:[...benz.atoms,...extra],bonds:[...benz.bonds,
      {i:2,j:6,order:1},{i:3,j:7,order:1},
      {i:0,j:8,order:1},{i:8,j:9,order:1},{i:9,j:10,order:1},
    ]};
  },

  'serotonin': L => {
    const ind=TEMPLATES['indole'](L);
    const H=L*0.866;
    // OH at C5 of benzene ring (idx3 in indole), ethylamine at C3 (idx8)
    const extra=[
      {idx:10,sym:'O',x:ind.atoms[3].x-H,y:ind.atoms[3].y},
      {idx:11,sym:'C',x:ind.atoms[8].x+H,y:ind.atoms[8].y+L*0.5},
      {idx:12,sym:'C',x:ind.atoms[8].x+2*H,y:ind.atoms[8].y+L},
      {idx:13,sym:'N',x:ind.atoms[8].x+3*H,y:ind.atoms[8].y+L*0.5},
    ];
    return {atoms:[...ind.atoms,...extra],bonds:[...ind.bonds,
      {i:3,j:10,order:1},
      {i:8,j:11,order:1},{i:11,j:12,order:1},{i:12,j:13,order:1},
    ]};
  },

  'adrenaline': L => {
    const benz=mkRing(6,Array(6).fill('C'),0,0,L,-Math.PI/2,true);
    const H=L*0.866;
    const extra=[
      {idx:6,sym:'O',x:benz.atoms[2].x-H,y:benz.atoms[2].y},
      {idx:7,sym:'O',x:benz.atoms[3].x-H,y:benz.atoms[3].y},
      // side chain: -CH(OH)-CH2-NH-CH3
      {idx:8,sym:'C',x:benz.atoms[0].x+H,y:benz.atoms[0].y-L*0.5},
      {idx:9,sym:'O',x:benz.atoms[0].x+H,y:benz.atoms[0].y-L*1.5},
      {idx:10,sym:'C',x:benz.atoms[0].x+2*H,y:benz.atoms[0].y-L},
      {idx:11,sym:'N',x:benz.atoms[0].x+3*H,y:benz.atoms[0].y-L*0.5},
      {idx:12,sym:'C',x:benz.atoms[0].x+4*H,y:benz.atoms[0].y-L},
    ];
    return {atoms:[...benz.atoms,...extra],bonds:[...benz.bonds,
      {i:2,j:6,order:1},{i:3,j:7,order:1},
      {i:0,j:8,order:1},{i:8,j:9,order:1},{i:8,j:10,order:1},
      {i:10,j:11,order:1},{i:11,j:12,order:1},
    ]};
  },

  'penicillin': L => {
    // β-lactam fused with thiazolidine ring
    return {atoms:[
      {idx:0,sym:'N',x:0,y:0},{idx:1,sym:'C',x:L,y:0},
      {idx:2,sym:'C',x:L,y:L},{idx:3,sym:'C',x:0,y:L},
      {idx:4,sym:'O',x:L*1.866,y:L*0.5}, // β-lactam C=O
      // thiazolidine: S, C, C
      {idx:5,sym:'S',x:-L,y:L},{idx:6,sym:'C',x:-L,y:0},
      {idx:7,sym:'C',x:-L*0.5,y:L*1.5},
      // COOH on thiazolidine C
      {idx:8,sym:'C',x:-L*2,y:0},{idx:9,sym:'O',x:-L*2.5,y:-L*0.866},{idx:10,sym:'O',x:-L*2.5,y:L*0.866},
    ],bonds:[
      {i:0,j:1,order:1},{i:1,j:2,order:1},{i:2,j:3,order:1},{i:3,j:0,order:1},{i:1,j:4,order:2},
      {i:3,j:5,order:1},{i:5,j:6,order:1},{i:6,j:0,order:1},{i:3,j:7,order:1},{i:7,j:5,order:1},
      {i:6,j:8,order:1},{i:8,j:9,order:2},{i:8,j:10,order:1},
    ]};
  },

  'glucose-6p': L => {
    const gl=TEMPLATES['glucose'](L);
    // Add phosphate at C6 (atom idx 10 = CH2, bond to O idx11 → replace with phosphate)
    gl.atoms.push({idx:12,sym:'P',x:gl.atoms[10].x+L*1.866,y:gl.atoms[10].y});
    gl.atoms.push({idx:13,sym:'O',x:gl.atoms[10].x+L*2.866,y:gl.atoms[10].y-L*0.5});
    gl.atoms.push({idx:14,sym:'O',x:gl.atoms[10].x+L*2.866,y:gl.atoms[10].y+L*0.5});
    gl.atoms.push({idx:15,sym:'O',x:gl.atoms[10].x+L*1.866,y:gl.atoms[10].y+L});
    gl.bonds.push({i:11,j:12,order:1},{i:12,j:13,order:2},{i:12,j:14,order:1},{i:12,j:15,order:1});
    return gl;
  },

  'pyruvate': L => ({
    atoms:[
      {idx:0,sym:'C',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},
      {idx:2,sym:'O',x:0,y:-L},{idx:3,sym:'C',x:L,y:0},
      {idx:4,sym:'O',x:L*1.5,y:-L*0.866},{idx:5,sym:'O',x:L*1.5,y:L*0.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:2},{i:1,j:3,order:1},{i:3,j:4,order:2},{i:3,j:5,order:1}]
  }),

  'acetyl-coa-simple': L => ({
    // Just show acetyl-S-CoA simplified as CH3-CO-S-
    atoms:[
      {idx:0,sym:'C',x:-L,y:0},{idx:1,sym:'C',x:0,y:0},
      {idx:2,sym:'O',x:0,y:-L},{idx:3,sym:'S',x:L,y:0},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:2},{i:1,j:3,order:1}]
  }),

  'citric-acid': L => ({
    atoms:[
      {idx:0,sym:'C',x:0,y:0},
      {idx:1,sym:'O',x:L*0.5,y:-L*0.866},{idx:2,sym:'O',x:L*0.5,y:L*0.866},
      {idx:3,sym:'C',x:-L,y:0},
      {idx:4,sym:'O',x:-L*1.5,y:-L*0.866},{idx:5,sym:'O',x:-L*1.5,y:L*0.866},
      {idx:6,sym:'C',x:-2*L,y:0},
      {idx:7,sym:'O',x:-L*2,y:-L},{idx:8,sym:'O',x:-L*3,y:0},
      {idx:9,sym:'C',x:-3*L,y:0},  // quaternary C
      {idx:10,sym:'C',x:-4*L,y:0},
      {idx:11,sym:'O',x:-L*4.5,y:-L*0.866},{idx:12,sym:'O',x:-L*4.5,y:L*0.866},
    ],
    bonds:[{i:0,j:1,order:2},{i:0,j:2,order:1},{i:0,j:3,order:1},
           {i:3,j:4,order:2},{i:3,j:5,order:1},{i:5,j:6,order:1},
           {i:6,j:7,order:2},{i:6,j:8,order:1},{i:8,j:9,order:1},
           {i:9,j:10,order:1},{i:10,j:11,order:2},{i:10,j:12,order:1}]
  }),

  // Functional groups
  'carboxyl': L => ({
    atoms:[
      {idx:0,sym:'C',x:0,y:0},
      {idx:1,sym:'O',x:L*0.5,y:-L*0.866},
      {idx:2,sym:'O',x:L*0.5,y: L*0.866},
    ],
    bonds:[{i:0,j:1,order:2},{i:0,j:2,order:1}]
  }),

  'phosphate': L => ({
    atoms:[
      {idx:0,sym:'P',x:0,y:0},
      {idx:1,sym:'O',x:0,y:-L},
      {idx:2,sym:'O',x:L,y:0},
      {idx:3,sym:'O',x:0,y:L},
      {idx:4,sym:'O',x:-L,y:0},
    ],
    bonds:[{i:0,j:1,order:2},{i:0,j:2,order:1},{i:0,j:3,order:1},{i:0,j:4,order:1}]
  }),

  'acetyl': L => ({
    atoms:[
      {idx:0,sym:'C',x:0,y:0},
      {idx:1,sym:'C',x:L,y:0},
      {idx:2,sym:'O',x:L*1.5,y:-L*0.866},
    ],
    bonds:[{i:0,j:1,order:1},{i:1,j:2,order:2}]
  }),
};

// ─── MOL Import ───────────────────────────────────────────────
function importMOL(input) {
  const file=input.files[0]; if (!file) return;
  const reader=new FileReader();
  reader.onload=e=>{ try{parseMOL(e.target.result);}catch(err){alert('MOL読込エラー:\n'+err.message);} input.value=''; };
  reader.readAsText(file);
}

function parseMOL(text) {
  const lines=text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  const cl=lines[3]||'';
  const na=parseInt(cl.substring(0,3).trim(),10), nb=parseInt(cl.substring(3,6).trim(),10);
  if (isNaN(na)||isNaN(nb)) throw new Error('counts lineが読めません');

  const mols=[];
  for (let i=0;i<na;i++) {
    const l=lines[4+i]||'';
    const x=parseFloat(l.substring(0,10).trim()), y=parseFloat(l.substring(10,20).trim());
    const sym=l.substring(31,34).trim();
    if (!sym) throw new Error(`原子行 ${i+1} が読めません`);
    mols.push({x,y,sym});
  }

  const xs=mols.map(a=>a.x), ys=mols.map(a=>a.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
  const mw=maxX-minX||1, mh=maxY-minY||1;
  const px=canvas.width*0.1, py=canvas.height*0.1;
  const scale=Math.min((canvas.width-px*2)/mw, (canvas.height-py*2)/mh, 80);
  const offX=px+(canvas.width-px*2-mw*scale)/2;
  const offY=py+(canvas.height-py*2-mh*scale)/2;

  saveHistory();
  state.atoms=[]; state.bonds=[];

  const map={};
  mols.forEach((m,i)=>{
    const id=state.nextId++;
    map[i+1]=id;
    // Convert from screen back to world (account for current zoom/pan)
    const sx=offX+(m.x-minX)*scale, sy=offY+(maxY-m.y)*scale;
    const {x:wx,y:wy}=s2w(sx,sy);
    state.atoms.push({id,x:wx,y:wy,symbol:m.sym,charge:0});
  });

  const btm={1:1,2:2,3:3,4:1};
  for (let i=0;i<nb;i++) {
    const l=lines[4+na+i]||'';
    const a1=parseInt(l.substring(0,3).trim(),10), a2=parseInt(l.substring(3,6).trim(),10);
    const tp=parseInt(l.substring(6,9).trim(),10);
    if (map[a1]&&map[a2])
      state.bonds.push({id:state.nextId++,a:map[a1],b:map[a2],order:btm[tp]||1,stereo:''});
  }
  updateInfoBar(); render(); localSMILES();
}

// ─── SVG Export ───────────────────────────────────────────────
function exportSVG() {
  // render to a temporary off-screen canvas and capture
  const w=canvas.width, h=canvas.height;
  const NS='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(NS,'svg');
  svg.setAttribute('width',w); svg.setAttribute('height',h); svg.setAttribute('xmlns',NS);

  const bg=document.createElementNS(NS,'rect');
  bg.setAttribute('width',w); bg.setAttribute('height',h); bg.setAttribute('fill',CANVAS_BG);
  svg.appendChild(bg);

  function sw(wx) { return (wx*state.zoom+state.panX).toFixed(2); }
  function sh(wy) { return (wy*state.zoom+state.panY).toFixed(2); }

  for (const b of state.bonds) {
    const a1=getAtom(b.a), a2=getAtom(b.b); if (!a1||!a2) continue;
    const el=document.createElementNS(NS,'line');
    el.setAttribute('x1',sw(a1.x)); el.setAttribute('y1',sh(a1.y));
    el.setAttribute('x2',sw(a2.x)); el.setAttribute('y2',sh(a2.y));
    el.setAttribute('stroke','#333'); el.setAttribute('stroke-width','2');
    el.setAttribute('stroke-linecap','round');
    svg.appendChild(el);
  }

  for (const a of state.atoms) {
    if (!showLabel(a)) continue;
    const t=document.createElementNS(NS,'text');
    t.setAttribute('x',sw(a.x)); t.setAttribute('y',sh(a.y));
    t.setAttribute('text-anchor','middle'); t.setAttribute('dominant-baseline','middle');
    t.setAttribute('font-family','sans-serif'); t.setAttribute('font-weight','bold');
    t.setAttribute('font-size',(a.symbol.length>1?12:15)*state.zoom);
    t.setAttribute('fill',ATOM_COLORS[a.symbol]||'#222');
    t.textContent=a.symbol;
    svg.appendChild(t);
  }

  const blob=new Blob([svg.outerHTML],{type:'image/svg+xml'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a'); link.href=url; link.download='molecule.svg'; link.click();
  URL.revokeObjectURL(url);
}

// ─── SMILES ───────────────────────────────────────────────────
function localSMILES() {
  if (!state.atoms.length){document.getElementById('smiles-display').textContent='-';return;}
  const adj={};
  state.atoms.forEach(a=>adj[a.id]=[]);
  state.bonds.forEach(b=>{adj[b.a].push({to:b.b,order:b.order});adj[b.b].push({to:b.a,order:b.order});});
  const vis=new Set();
  const bc=o=>o===2?'=':o===3?'#':'';
  function dfs(id,from) {
    vis.add(id);
    const a=getAtom(id);
    let s=a.symbol==='C'?'C':a.symbol;
    const nb=adj[id].filter(n=>!vis.has(n.to));
    nb.forEach((n,i)=>{
      const sub=dfs(n.to,id);
      if(i<nb.length-1) s+=`(${bc(n.order)}${sub})`;
      else s+=bc(n.order)+sub;
    });
    return s;
  }
  let smiles='';
  for (const a of state.atoms) {
    if (!vis.has(a.id)){if(smiles)smiles+='.';smiles+=dfs(a.id,null);}
  }
  document.getElementById('smiles-display').textContent=smiles;
}

// ─── Backend ──────────────────────────────────────────────────
const API='http://localhost:8000';

async function checkBackend() {
  try {
    const r=await fetch(API+'/health',{signal:AbortSignal.timeout(2000)});
    if (r.ok){document.getElementById('backend-status').textContent='接続済み';document.getElementById('backend-status').style.color='#2ecc71';}
  } catch { /* silent */ }
}

async function callBackend() {
  try {
    const r=await fetch(API+'/smiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({atoms:state.atoms,bonds:state.bonds})});
    const d=await r.json();
    if (d.smiles){document.getElementById('smiles-display').textContent=d.smiles;alert('SMILES: '+d.smiles);}
    else alert('エラー: '+(d.error||'不明'));
  } catch { alert('バックエンドに接続できません。'); }
}

// ─── Canvas clear ─────────────────────────────────────────────
function clearCanvas() {
  saveHistory(); state.atoms=[]; state.bonds=[];
  updateInfoBar(); document.getElementById('smiles-display').textContent='-'; render();
}
