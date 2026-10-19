// The studio map: one extruded hex prism per state on a lit studio table. Fixed camera, slight top-down, gentle idle breathing.
// Height = how decided the race is (|pD − 0.5|), colour = RED ↔ purple ↔ BLUE by the reference odds (grey when no race).
// Render rules: one key light (shadows) + soft fill + a rim from behind, matte MeshStandard (roughness ≥ 0.6), contact shadow on
// the table. No bloom, grain, vignette, environment maps, orbiting or scroll-driven camera.
import * as THREE from 'three'
import { LAYOUT, hexXZ, ORDER } from './hexgrid.js'

const C_RED = [0xe0, 0x32, 0x3c], C_PUR = [0x8a, 0x5c, 0xf6], C_BLUE = [0x2f, 0x6b, 0xff], C_GREY = [0x4a, 0x55, 0x78]
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
export function leanRGB(pD) {
  if (pD == null || isNaN(pD)) return C_GREY
  const t = Math.min(1, Math.max(0, pD))
  return t < 0.5 ? mix(C_RED, C_PUR, t / 0.5) : mix(C_PUR, C_BLUE, (t - 0.5) / 0.5)
}
export const leanCss = (pD) => `rgb(${leanRGB(pD).map((v) => Math.round(v)).join(',')})`
// kept low enough that, from the fixed camera, no prism hides the cell behind it; 'no race' keeps a visible base
const heightFor = (row) => (row && row.pD != null ? 0.24 + Math.abs(row.pD - 0.5) * 2 * 0.72 : 0.2)

export function createMap({ canvas, labels, onHover, onSelect, reduced = false, mobile = false }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  const BG = new THREE.Color('#070d20')
  scene.background = BG
  scene.fog = new THREE.Fog(BG, 34, 70)

  // map extents (circumradius 1)
  const pts = Object.keys(LAYOUT).map(hexXZ)
  const minX = Math.min(...pts.map((p) => p[0])) - 1, maxX = Math.max(...pts.map((p) => p[0])) + 1
  const minZ = Math.min(...pts.map((p) => p[1])) - 1, maxZ = Math.max(...pts.map((p) => p[1])) + 1
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
  const W = maxX - minX, D = maxZ - minZ

  // ── studio: floor, table, lit rim ─────────────────────────────────────────────────────────
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), new THREE.MeshStandardMaterial({ color: '#0a1330', roughness: 0.95, metalness: 0 }))
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.32; floor.receiveShadow = true
  scene.add(floor)
  const tableW = W + 2.6, tableD = D + 2.4
  const table = new THREE.Mesh(new THREE.BoxGeometry(tableW, 0.3, tableD), new THREE.MeshStandardMaterial({ color: '#0f1a3d', roughness: 0.82, metalness: 0 }))
  table.position.y = -0.15; table.receiveShadow = true; table.castShadow = true
  scene.add(table)
  const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(tableW, 0.3, tableD)), new THREE.LineBasicMaterial({ color: '#5a78d6', transparent: true, opacity: 0.55 }))
  rim.position.copy(table.position)
  scene.add(rim)

  // ── lights: key (shadows) + fill + rim from behind ───────────────────────────────────────
  scene.add(new THREE.HemisphereLight('#c4d0ff', '#0a1022', 0.7))
  const key = new THREE.DirectionalLight('#ffffff', 2.4)
  key.position.set(-9, 18, 11)
  key.castShadow = true
  key.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048)
  Object.assign(key.shadow.camera, { left: -16, right: 16, top: 12, bottom: -12, near: 1, far: 60 })
  key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02; key.shadow.radius = 3
  scene.add(key)
  const fill = new THREE.DirectionalLight('#9fb2ff', 0.55)
  fill.position.set(12, 8, 9)
  scene.add(fill)
  const rimL = new THREE.DirectionalLight('#b9c8ff', 1.6)
  rimL.position.set(3, 7, -16)
  scene.add(rimL)

  // ── prisms ───────────────────────────────────────────────────────────────────────────────
  const R = 0.94
  const geo = new THREE.CylinderGeometry(R, R, 1, 6, 1, false)
  geo.translate(0, 0.5, 0)
  const capGeo = new THREE.CylinderGeometry(R * 0.86, R * 0.86, 0.07, 6)
  const ringGeo = (() => { const g = new THREE.BufferGeometry(); const p = []; for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI * 2; p.push(Math.sin(a) * R * 0.86, 0, Math.cos(a) * R * 0.86) } g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); return g })()
  const topGeo = (() => { const g = new THREE.BufferGeometry(); const p = []; for (let i = 0; i <= 6; i++) { const a = (i / 6) * Math.PI * 2; p.push(Math.sin(a) * R, 0, Math.cos(a) * R) } g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); return g })()

  const hexes = new Map()
  const group = new THREE.Group()
  group.position.set(-cx, 0, -cz)
  scene.add(group)
  const pickables = []
  ORDER.forEach((st, i) => {
    const [x, z] = hexXZ(st)
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...C_GREY.map((v) => v / 255), THREE.SRGBColorSpace), roughness: 0.66, metalness: 0, emissive: '#000000' })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(x, 0, z)
    mesh.castShadow = true; mesh.receiveShadow = true
    mesh.scale.y = reduced ? 0.2 : 0.001
    mesh.userData.st = st
    group.add(mesh); pickables.push(mesh)
    const edge = new THREE.LineLoop(topGeo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.16 }))
    edge.position.set(x, 0, z)
    group.add(edge)
    const cap = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, metalness: 0 }))
    cap.position.set(x, 0, z); cap.visible = false; cap.castShadow = false
    group.add(cap)
    const ring = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: '#ffffff' }))
    ring.position.set(x, 0, z); ring.visible = false
    group.add(ring)
    const lab = document.createElement('div')
    lab.className = 'hx-lab'
    lab.innerHTML = `<b>${st}</b><i class="called-tag" hidden>CALLED</i>`
    labels.append(lab)
    hexes.set(st, {
      st, mesh, mat, edge, cap, ring, lab, x, z, i, phase: (x * 0.7 + z * 1.3) % (Math.PI * 2),
      h: reduced ? 0.2 : 0.001, th: 0.2, col: [...C_GREY], tcol: [...C_GREY], lift: 0, tlift: 0, called: false, row: null,
      delay: reduced ? 0 : 0.15 + (x + z) * 0.03,
    })
  })

  // ── camera: fixed, slight top-down, fitted to the map ───────────────────────────────────
  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 200)
  const tilt = THREE.MathUtils.degToRad(mobile ? 72 : 66)
  const target = new THREE.Vector3(0, 0.3, mobile ? 0.2 : 1.1)
  function fit() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    const vf = THREE.MathUtils.degToRad(camera.fov)
    const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect)
    const dW = (W * 0.5 + 0.3) / Math.tan(hf / 2) + D * 0.3
    const dD = ((D * Math.sin(tilt)) * 0.5 + 1.6) / Math.tan(vf / 2) + 2
    const d = Math.max(dW, dD)
    camera.position.set(target.x, target.y + Math.sin(tilt) * d, target.z + Math.cos(tilt) * d)
    camera.lookAt(target)
    camera.updateProjectionMatrix()
    scene.fog.near = d * 1.25; scene.fog.far = d * 2.6
    dirty = true
  }

  // ── data ────────────────────────────────────────────────────────────────────────────────
  function setData(states) {
    for (const hx of hexes.values()) {
      const row = states?.[hx.st] || null
      hx.row = row
      hx.th = heightFor(row)
      hx.tcol = [...leanRGB(row?.pD)]
      hx.called = !!row?.result
      hx.lab.classList.toggle('none', !row)
      hx.lab.querySelector('.called-tag').hidden = !hx.called
      hx.lab.classList.toggle('called', hx.called)
      if (hx.called) {
        const solid = String(row.result).toUpperCase().startsWith('D') ? C_BLUE : C_RED
        hx.tcol = [...solid]
        hx.cap.material.color.setRGB(...solid.map((v) => Math.min(255, v * 1.12) / 255), THREE.SRGBColorSpace)
      }
      hx.cap.visible = hx.ring.visible = hx.called
      if (reduced) { hx.h = hx.th; hx.col = [...hx.tcol] }
    }
    dirty = true
  }

  // ── interaction ─────────────────────────────────────────────────────────────────────────
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
  let hovered = null, selected = null
  function setHover(st) {
    if (st === hovered) return
    hovered = st
    for (const hx of hexes.values()) { hx.tlift = hx.st === hovered || hx.st === selected ? 0.12 : 0; hx.lab.classList.toggle('on', hx.st === hovered || hx.st === selected) }
    canvas.style.cursor = st ? 'pointer' : ''
    onHover?.(st || selected)
    dirty = true
  }
  function pickAt(ev) {
    const r = canvas.getBoundingClientRect()
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObjects(pickables, false)[0]
    return hit ? hit.object.userData.st : null
  }
  canvas.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse') setHover(pickAt(ev)) })
  canvas.addEventListener('pointerleave', () => setHover(null))
  canvas.addEventListener('click', (ev) => { const st = pickAt(ev); select(st && st !== selected ? st : null) })
  function select(st) {
    selected = st
    hovered = null
    for (const hx of hexes.values()) { hx.tlift = hx.st === selected ? 0.12 : 0; hx.lab.classList.toggle('on', hx.st === selected) }
    onSelect?.(st)
    dirty = true
  }

  // ── loop ────────────────────────────────────────────────────────────────────────────────
  const v = new THREE.Vector3()
  let dirty = true, running = true, t0 = performance.now(), last = t0
  function frame(now) {
    if (!running) return
    requestAnimationFrame(frame)
    const t = (now - t0) / 1000, dt = Math.min(0.05, (now - last) / 1000); last = now
    const k = reduced ? 1 : 1 - Math.pow(0.0025, dt)
    let moving = !reduced
    for (const hx of hexes.values()) {
      if (t < hx.delay) continue
      const dh = hx.th - hx.h, dl = hx.tlift - hx.lift
      if (Math.abs(dh) > 1e-4 || Math.abs(dl) > 1e-4) { hx.h += dh * k; hx.lift += dl * k; moving = true }
      for (let c = 0; c < 3; c++) { const d = hx.tcol[c] - hx.col[c]; if (Math.abs(d) > 0.05) { hx.col[c] += d * k; moving = true } }
    }
    if (!moving && !dirty) return
    dirty = false
    const cw = canvas.clientWidth, ch = canvas.clientHeight
    for (const hx of hexes.values()) {
      const breathe = reduced ? 1 : 1 + 0.03 * Math.sin(t * 0.9 + hx.phase)
      const hh = Math.max(0.001, hx.h * breathe)
      hx.mesh.scale.y = hh
      hx.mesh.position.y = hx.lift
      hx.edge.position.y = hh + hx.lift + 0.002
      hx.cap.position.y = hh + hx.lift + 0.035
      hx.ring.position.y = hh + hx.lift + 0.072
      const sel = hx.st === hovered || hx.st === selected
      hx.mat.color.setRGB(...hx.col.map((c) => c / 255), THREE.SRGBColorSpace)
      hx.mat.emissive.set(sel ? '#2a3566' : '#000000')
      hx.edge.material.opacity = sel ? 0.9 : 0.16
      // label above the prism top
      v.set(hx.x - cx, hh + hx.lift + (hx.called ? 0.1 : 0.02), hx.z - cz).project(camera)
      const px = (v.x * 0.5 + 0.5) * cw, py = (-v.y * 0.5 + 0.5) * ch
      hx.lab.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -50%)`
    }
    renderer.render(scene, camera)
  }

  const ro = new ResizeObserver(fit)
  ro.observe(canvas)
  fit()
  requestAnimationFrame(frame)
  const io = new IntersectionObserver(([e]) => {
    const vis = e.isIntersecting
    if (vis && !running) { running = true; last = performance.now(); dirty = true; requestAnimationFrame(frame) } else if (!vis) running = false
  })
  io.observe(canvas)

  return {
    setData,
    hover: setHover,
    select,
    get selected() { return selected },
    focusNext(dir) {
      const list = ORDER.filter((s) => hexes.get(s).row)
      if (!list.length) return null
      const cur = selected ?? hovered
      let i = list.indexOf(cur)
      i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length
      select(list[i])
      return list[i]
    },
    dispose() { running = false; ro.disconnect(); io.disconnect(); renderer.dispose() },
  }
}
