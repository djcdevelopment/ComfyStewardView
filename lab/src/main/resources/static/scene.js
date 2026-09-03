const PAGE_STARTED = performance.now();
const APP_BASE = new URL('.', location.href);
const params = new URLSearchParams(location.search);
const statusNode = document.getElementById('scene-status');
const blockedNode = document.getElementById('scene-blocked');
const errors = [];
let deviceLost = false;
let receipt = {
  schema:'steward-scene-browser/v1', status:'loading', pieces:0,
  validationErrors:errors, deviceLost:false
};

function publish(patch = {}) {
  receipt = { ...receipt, ...patch, validationErrors:[...errors], deviceLost };
  window.__stewardSceneReceipt = receipt;
}
publish();

function fail(error) {
  const message = error?.message || String(error);
  console.error(error);
  statusNode.textContent = `BLOCKED · ${message}`;
  document.getElementById('blocked-title').textContent = message.includes('WebGPU')
    ? 'This browser could not start WebGPU' : 'This exact scene could not open';
  document.getElementById('blocked-copy').textContent = message;
  blockedNode.hidden = false;
  document.documentElement.dataset.sceneReady = 'error';
  publish({ status:'error', error:message });
}

const fmt = value => Number(value || 0).toLocaleString();
const fmtBytes = value => value < 1024 * 1024
  ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(2)} MiB`;
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const percentile = (values, p) => {
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
};

function requiredNumber(name) {
  const raw = params.get(name);
  if (raw == null || raw.trim() === '') throw new Error(`The shared scene URL is missing ${name}.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`The shared scene URL is missing ${name}.`);
  return value;
}

function sceneRequestUrl() {
  const snapshot = requiredNumber('snapshot');
  const minX = requiredNumber('minX'), maxX = requiredNumber('maxX');
  const minZ = requiredNumber('minZ'), maxZ = requiredNumber('maxZ');
  if (snapshot <= 0 || minX >= maxX || minZ >= maxZ) throw new Error('The shared scene bounds are invalid.');
  const query = new URLSearchParams({
    snapshot:String(snapshot), lens:params.get('lens') || 'build-density',
    minX:String(minX), maxX:String(maxX), minZ:String(minZ), maxZ:String(maxZ)
  });
  if (params.get('biomes')) query.set('biomes', params.get('biomes'));
  if (params.get('override') === 'true' || params.get('override') === '1') query.set('override', 'true');
  const url = new URL('api/scene', APP_BASE);
  url.search = query.toString();
  return url;
}

async function fetchScene() {
  const response = await fetch(sceneRequestUrl(), { headers:{ Accept:'application/vnd.comfysteward.scene' } });
  const buffer = await response.arrayBuffer();
  if (!response.ok) {
    let message = `Scene request failed (${response.status})`;
    try { message = JSON.parse(new TextDecoder().decode(buffer)).error || message; } catch (_) {}
    throw new Error(message);
  }
  if (buffer.byteLength < 16) throw new Error('The scene package is incomplete.');
  const header = new DataView(buffer, 0, 16);
  const magic = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, 4));
  const version = header.getUint32(4, true);
  const manifestLength = header.getUint32(8, true);
  const instanceOffset = header.getUint32(12, true);
  if (magic !== 'SV3D' || version !== 1) throw new Error('The scene package format is not supported.');
  if (instanceOffset % 4 || instanceOffset < 16 + manifestLength || instanceOffset > buffer.byteLength) {
    throw new Error('The scene package offsets are invalid.');
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 16, manifestLength)));
  } catch (_) {
    throw new Error('The scene manifest could not be decoded.');
  }
  if (manifest.schema !== 'steward-zdo-scene/v1' || manifest.instanceStride !== 80 ||
      manifest.instanceBytes !== buffer.byteLength - instanceOffset ||
      manifest.instanceBytes !== manifest.pieces * manifest.instanceStride) {
    throw new Error('The scene manifest does not match its exact instance payload.');
  }
  let expectedStart = 0;
  for (const family of manifest.families || []) {
    if (family.start !== expectedStart || family.count < 1) throw new Error('The family draw ranges are invalid.');
    expectedStart += family.count;
  }
  if (expectedStart !== manifest.pieces) throw new Error('The family ranges do not cover every piece.');
  const bytes = new Uint8Array(buffer, instanceOffset, manifest.instanceBytes);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== manifest.instanceSha256) throw new Error('The exact scene payload failed its checksum.');
  return { manifest, bytes };
}

function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
    out[column * 4 + row] = sum;
  }
  return out;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), out = new Float32Array(16);
  out[0] = f / aspect; out[5] = f;
  out[10] = far / (near - far); out[11] = -1;
  out[14] = far * near / (near - far);
  return out;
}

const add = (a,b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const scale = (a,n) => [a[0]*n, a[1]*n, a[2]*n];
const dot = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm = a => { const length = Math.hypot(...a) || 1; return scale(a, 1 / length); };

function lookAt(eye, target, up) {
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([
    x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
    -dot(x,eye),-dot(y,eye),-dot(z,eye),1
  ]);
}

function adapterRecord(info) {
  const out = {};
  for (const key of ['vendor','architecture','device','description','type','backend','d3dShaderModel']) {
    try { if (info?.[key] !== undefined && info[key] !== '') out[key] = info[key]; } catch (_) {}
  }
  return out;
}

function classifyAdapter(info) {
  const text = Object.values(info).join(' ').toLowerCase();
  if (/swiftshader|software|llvmpipe|warp|fallback|cpu/.test(text)) return 'software';
  if (/discrete gpu|integrated gpu|intel|nvidia|amd|radeon|arc|geforce|apple/.test(text)) return 'hardware';
  return 'unknown';
}

function gpuBuffer(device, data, usage, label) {
  const buffer = device.createBuffer({ label, size:(data.byteLength + 3) & ~3, usage, mappedAtCreation:true });
  new data.constructor(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

function niceGridStep(span) {
  const target = Math.max(span / 20, .25);
  const base = 10 ** Math.floor(Math.log10(target));
  for (const multiple of [1,2,5,10]) if (base * multiple >= target) return base * multiple;
  return base * 10;
}

function gridVertices(manifest) {
  const [width,,depth] = manifest.dimensionsM;
  const step = niceGridStep(Math.max(width, depth));
  const halfX = Math.ceil(Math.max(width / 2, step) / step) * step;
  const halfZ = Math.ceil(Math.max(depth / 2, step) / step) * step;
  const y = Number(manifest.floorY) - .006;
  const values = [];
  const line = (a,b,color) => values.push(...a,...color,...b,...color);
  const minor = [.24,.31,.36,.42], major = [.39,.49,.55,.66];
  for (let x = -halfX, i = 0; x <= halfX + step * .1; x += step, i++) {
    line([x,y,-halfZ],[x,y,halfZ], i % 5 === 0 ? major : minor);
  }
  for (let z = -halfZ, i = 0; z <= halfZ + step * .1; z += step, i++) {
    line([-halfX,y,z],[halfX,y,z], i % 5 === 0 ? major : minor);
  }
  line([-halfX,y,0],[halfX,y,0],[.55,.25,.24,.9]);
  line([0,y,-halfZ],[0,y,halfZ],[.25,.47,.66,.9]);
  return { values:new Float32Array(values), step };
}

function titleCase(value) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

async function main() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a current hardware-accelerated browser.');
  const { manifest, bytes:instanceData } = await fetchScene();
  publish({ pieces:manifest.pieces, instanceBytes:manifest.instanceBytes, instanceSha256:manifest.instanceSha256 });
  statusNode.textContent = 'REQUESTING HARDWARE ADAPTER…';
  const adapter = await navigator.gpu.requestAdapter({ powerPreference:'high-performance' });
  if (!adapter) throw new Error('WebGPU could not provide an adapter. Check browser hardware acceleration.');
  const adapterInfo = adapterRecord(adapter.info);
  const adapterClass = classifyAdapter(adapterInfo);
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', event => {
    errors.push(String(event.error?.message || event.error));
    publish();
  });
  device.lost.then(info => {
    deviceLost = true;
    errors.push(`device lost: ${info.reason} ${info.message}`);
    publish({ status:'device-lost' });
  });

  const canvas = document.getElementById('gpu'), stage = document.getElementById('stage');
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('The browser has WebGPU but could not create a canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  let depthTexture;
  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(stage.clientWidth * ratio));
    const height = Math.max(1, Math.floor(stage.clientHeight * ratio));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width; canvas.height = height;
    context.configure({ device, format, alphaMode:'opaque' });
    depthTexture?.destroy();
    depthTexture = device.createTexture({ size:[width,height], format:'depth24plus', usage:GPUTextureUsage.RENDER_ATTACHMENT });
    return true;
  }

  const solidVertices = new Float32Array([
    -.5,-.5,.5,0,0,1, .5,-.5,.5,0,0,1, .5,.5,.5,0,0,1, -.5,.5,.5,0,0,1,
    .5,-.5,-.5,0,0,-1, -.5,-.5,-.5,0,0,-1, -.5,.5,-.5,0,0,-1, .5,.5,-.5,0,0,-1,
    .5,-.5,.5,1,0,0, .5,-.5,-.5,1,0,0, .5,.5,-.5,1,0,0, .5,.5,.5,1,0,0,
    -.5,-.5,-.5,-1,0,0, -.5,-.5,.5,-1,0,0, -.5,.5,.5,-1,0,0, -.5,.5,-.5,-1,0,0,
    -.5,.5,.5,0,1,0, .5,.5,.5,0,1,0, .5,.5,-.5,0,1,0, -.5,.5,-.5,0,1,0,
    -.5,-.5,-.5,0,-1,0, .5,-.5,-.5,0,-1,0, .5,-.5,.5,0,-1,0, -.5,-.5,.5,0,-1,0
  ]);
  const solidIndices = new Uint16Array([
    0,1,2,0,2,3,4,5,6,4,6,7,8,9,10,8,10,11,12,13,14,12,14,15,
    16,17,18,16,18,19,20,21,22,20,22,23
  ]);
  const lineVertices = new Float32Array([
    -.5,-.5,-.5, -.5,-.5,.5, -.5,.5,-.5, -.5,.5,.5,
    .5,-.5,-.5, .5,-.5,.5, .5,.5,-.5, .5,.5,.5
  ]);
  const lineIndices = new Uint16Array([0,1,0,2,0,4,1,3,1,5,2,3,2,6,3,7,4,5,4,6,5,7,6,7]);
  const grid = gridVertices(manifest);
  const solidVB = gpuBuffer(device, solidVertices, GPUBufferUsage.VERTEX, 'solid cube');
  const solidIB = gpuBuffer(device, solidIndices, GPUBufferUsage.INDEX, 'solid indices');
  const lineVB = gpuBuffer(device, lineVertices, GPUBufferUsage.VERTEX, 'wire cube');
  const lineIB = gpuBuffer(device, lineIndices, GPUBufferUsage.INDEX, 'wire indices');
  const gridVB = gpuBuffer(device, grid.values, GPUBufferUsage.VERTEX, 'selection-local grid');
  const instanceBuffer = gpuBuffer(device, instanceData, GPUBufferUsage.VERTEX, 'exact ZDO instances');
  const cameraBuffer = device.createBuffer({ size:64, usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const shader = device.createShaderModule({ code:`
    struct Camera { viewProjection:mat4x4<f32> }
    @group(0) @binding(0) var<uniform> camera:Camera;
    struct SolidIn {
      @location(0) position:vec3f, @location(1) normal:vec3f,
      @location(2) m0:vec4f, @location(3) m1:vec4f,
      @location(4) m2:vec4f, @location(5) m3:vec4f, @location(6) color:vec4f
    }
    struct SolidOut { @builtin(position) position:vec4f, @location(0) color:vec4f, @location(1) normal:vec3f }
    @vertex fn solidVS(input:SolidIn)->SolidOut {
      let model=mat4x4f(input.m0,input.m1,input.m2,input.m3);
      let basis=mat3x3f(normalize(input.m0.xyz),normalize(input.m1.xyz),normalize(input.m2.xyz));
      var out:SolidOut; out.position=camera.viewProjection*model*vec4f(input.position,1);
      out.color=input.color; out.normal=basis*input.normal; return out;
    }
    @fragment fn solidFS(input:SolidOut)->@location(0) vec4f {
      let diffuse=0.28+0.72*max(dot(normalize(input.normal),normalize(vec3f(-.45,.8,.32))),0);
      let horizon=0.9+0.1*max(normalize(input.normal).y,0);
      return vec4f(input.color.rgb*diffuse*horizon,1);
    }
    struct LineIn { @location(0) position:vec3f,
      @location(2) m0:vec4f, @location(3) m1:vec4f,
      @location(4) m2:vec4f, @location(5) m3:vec4f, @location(6) color:vec4f }
    struct LineOut { @builtin(position) position:vec4f, @location(0) color:vec4f }
    @vertex fn lineVS(input:LineIn)->LineOut {
      let model=mat4x4f(input.m0,input.m1,input.m2,input.m3);
      var out:LineOut; out.position=camera.viewProjection*model*vec4f(input.position,1);
      out.color=vec4f(min(input.color.rgb*1.25,vec3f(1)),1); return out;
    }
    @fragment fn lineFS(input:LineOut)->@location(0) vec4f { return input.color; }
    struct GridIn { @location(0) position:vec3f, @location(1) color:vec4f }
    struct GridOut { @builtin(position) position:vec4f, @location(0) color:vec4f }
    @vertex fn gridVS(input:GridIn)->GridOut {
      var out:GridOut; out.position=camera.viewProjection*vec4f(input.position,1);
      out.color=input.color; return out;
    }
    @fragment fn gridFS(input:GridOut)->@location(0) vec4f { return input.color; }
  `});
  const instanceLayout = { arrayStride:80, stepMode:'instance', attributes:[
    {shaderLocation:2,offset:0,format:'float32x4'}, {shaderLocation:3,offset:16,format:'float32x4'},
    {shaderLocation:4,offset:32,format:'float32x4'}, {shaderLocation:5,offset:48,format:'float32x4'},
    {shaderLocation:6,offset:64,format:'float32x4'}
  ]};
  const bindLayout = device.createBindGroupLayout({ entries:[{
    binding:0, visibility:GPUShaderStage.VERTEX, buffer:{type:'uniform'}
  }]});
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts:[bindLayout] });
  const depthStencil = { format:'depth24plus', depthWriteEnabled:true, depthCompare:'less' };
  const solidPipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{ module:shader, entryPoint:'solidVS', buffers:[{arrayStride:24,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'}, {shaderLocation:1,offset:12,format:'float32x3'}
    ]},instanceLayout]}, fragment:{module:shader,entryPoint:'solidFS',targets:[{format}]},
    primitive:{topology:'triangle-list',cullMode:'back'}, depthStencil });
  const linePipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{ module:shader, entryPoint:'lineVS', buffers:[{arrayStride:12,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'}
    ]},instanceLayout]}, fragment:{module:shader,entryPoint:'lineFS',targets:[{format}]},
    primitive:{topology:'line-list'}, depthStencil });
  const gridPipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{ module:shader, entryPoint:'gridVS', buffers:[{arrayStride:28,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'}, {shaderLocation:1,offset:12,format:'float32x4'}
    ]}]}, fragment:{module:shader,entryPoint:'gridFS',targets:[{format,blend:{
      color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},
      alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}
    }}]}, primitive:{topology:'line-list'},
    depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less-equal'} });
  const bindGroup = device.createBindGroup({ layout:bindLayout, entries:[{binding:0,resource:{buffer:cameraBuffer}}] });

  const radius = Math.max(Number(manifest.radiusM) || 1, 1);
  let surface = 'shaded', cameraMode = 'orbit';
  let orbitYaw = -35 * Math.PI / 180, orbitPitch = -28 * Math.PI / 180;
  let orbitDistance = radius * 2.45, orbitTarget = [0,0,0];
  let flyPosition = [0,0,radius * 2.45], flyYaw = Math.PI, flyPitch = 0;
  let flySpeed = Math.max(5, radius * .35);
  const visible = new Set(manifest.families.map((_, index) => index));
  const keys = new Set();
  let lastViewProjection = new Float32Array(16);

  function forwardVector() {
    return [Math.sin(flyYaw)*Math.cos(flyPitch), Math.sin(flyPitch), Math.cos(flyYaw)*Math.cos(flyPitch)];
  }
  function orbitEye() {
    return add(orbitTarget, [
      Math.sin(orbitYaw)*Math.cos(orbitPitch)*orbitDistance,
      Math.sin(orbitPitch)*orbitDistance,
      Math.cos(orbitYaw)*Math.cos(orbitPitch)*orbitDistance
    ]);
  }
  function cameraMatrix() {
    const eye = cameraMode === 'fly' ? flyPosition : orbitEye();
    const target = cameraMode === 'fly' ? add(flyPosition, forwardVector()) : orbitTarget;
    const near = Math.max(.02, radius * .0003);
    const far = Math.max(radius * 20, orbitDistance * 4, 100);
    return multiply4(perspective(42*Math.PI/180, canvas.width/canvas.height, near, far), lookAt(eye,target,[0,1,0]));
  }
  function render() {
    resize();
    lastViewProjection = cameraMatrix();
    device.queue.writeBuffer(cameraBuffer, 0, lastViewProjection);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments:[{
      view:context.getCurrentTexture().createView(), clearValue:{r:.028,g:.04,b:.052,a:1},
      loadOp:'clear', storeOp:'store'
    }], depthStencilAttachment:{view:depthTexture.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'} });
    pass.setPipeline(gridPipeline); pass.setBindGroup(0,bindGroup); pass.setVertexBuffer(0,gridVB);
    pass.draw(grid.values.length / 7);
    const wire = surface === 'wire';
    pass.setPipeline(wire ? linePipeline : solidPipeline); pass.setBindGroup(0,bindGroup);
    pass.setVertexBuffer(0,wire ? lineVB : solidVB); pass.setVertexBuffer(1,instanceBuffer);
    pass.setIndexBuffer(wire ? lineIB : solidIB,'uint16');
    for (let index = 0; index < manifest.families.length; index++) if (visible.has(index)) {
      const family = manifest.families[index];
      pass.drawIndexed(wire ? 24 : 36, family.count, 0, 0, family.start);
    }
    pass.end(); device.queue.submit([encoder.finish()]);
  }

  function setSurface(value) {
    surface = value === 'wire' ? 'wire' : 'shaded';
    document.querySelectorAll('[data-surface]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.surface === surface)));
    render(); publish({ surface, drawCalls:visible.size + 1 });
  }
  function setCameraMode(value, requestLock = false) {
    value = value === 'fly' ? 'fly' : 'orbit';
    if (value === cameraMode) {
      if (value === 'fly' && requestLock) canvas.requestPointerLock?.();
      return;
    }
    if (value === 'fly') {
      flyPosition = orbitEye();
      const direction = norm(sub(orbitTarget, flyPosition));
      flyYaw = Math.atan2(direction[0], direction[2]);
      flyPitch = Math.asin(Math.max(-1,Math.min(1,direction[1])));
    } else {
      const direction = forwardVector();
      orbitDistance = Math.max(radius * .3, Math.min(radius * 5, orbitDistance));
      orbitTarget = add(flyPosition, scale(direction, orbitDistance));
      orbitYaw = Math.atan2(-direction[0], -direction[2]);
      orbitPitch = Math.asin(Math.max(-1,Math.min(1,-direction[1])));
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    cameraMode = value;
    document.querySelectorAll('[data-camera]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.camera === cameraMode)));
    updateCameraHelp(); render(); publish({ cameraMode });
    if (cameraMode === 'fly' && requestLock) canvas.requestPointerLock?.();
  }
  function resetCamera() {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    cameraMode = 'orbit'; orbitYaw = -35*Math.PI/180; orbitPitch = -28*Math.PI/180;
    orbitDistance = radius * 2.45; orbitTarget = [0,0,0];
    document.querySelectorAll('[data-camera]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.camera === 'orbit')));
    updateCameraHelp(); render(); publish({ cameraMode });
  }
  function updateCameraHelp() {
    const locked = document.pointerLockElement === canvas;
    document.getElementById('camera-help').textContent = cameraMode === 'orbit'
      ? 'Drag to orbit · Shift-drag to pan · wheel to zoom'
      : locked ? 'Mouse look · WASD move · Q/E down/up · Shift boost · Escape releases mouse'
      : 'Click the view to capture the mouse · WASD + Q/E · Shift boost';
    document.getElementById('stage-hint').textContent = cameraMode === 'orbit'
      ? 'Drag to orbit · wheel to zoom'
      : locked ? 'WASD + Q/E · Shift boost · Escape releases mouse' : 'Click to enter free-camera fly mode';
  }

  document.querySelectorAll('[data-surface]').forEach(button =>
    button.addEventListener('click', () => setSurface(button.dataset.surface)));
  document.querySelectorAll('[data-camera]').forEach(button =>
    button.addEventListener('click', () => setCameraMode(button.dataset.camera, button.dataset.camera === 'fly')));
  document.getElementById('frame-scene').addEventListener('click', resetCamera);
  document.getElementById('families-all').addEventListener('click', () => {
    manifest.families.forEach((_,index) => visible.add(index));
    document.querySelectorAll('#families input').forEach(input => { input.checked = true; });
    render(); publish({ drawCalls:visible.size + 1 });
  });

  const familyBox = document.getElementById('families');
  manifest.families.forEach((family,index) => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = true;
    input.addEventListener('change', () => {
      input.checked ? visible.add(index) : visible.delete(index);
      render(); publish({ drawCalls:visible.size + 1 });
    });
    const swatch = document.createElement('i'); swatch.style.setProperty('--swatch',family.color);
    const name = document.createElement('span'); name.textContent = titleCase(family.name);
    const count = document.createElement('small'); count.textContent = fmt(family.count);
    label.append(input,swatch,name,count); familyBox.appendChild(label);
  });

  let dragging = false, panning = false, lastX = 0, lastY = 0;
  stage.addEventListener('contextmenu', event => event.preventDefault());
  stage.addEventListener('pointerdown', event => {
    if (cameraMode === 'fly') {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
      return;
    }
    dragging = true; panning = event.shiftKey || event.button === 1 || event.button === 2;
    lastX = event.clientX; lastY = event.clientY; stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!dragging || cameraMode !== 'orbit') return;
    const dx = event.clientX - lastX, dy = event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY;
    if (panning) {
      const eye = orbitEye(), forward = norm(sub(orbitTarget,eye));
      const right = norm(cross(forward,[0,1,0])), up = norm(cross(right,forward));
      const amount = orbitDistance * .0015;
      orbitTarget = add(orbitTarget, add(scale(right,-dx*amount),scale(up,dy*amount)));
    } else {
      orbitYaw += dx * .006; orbitPitch += dy * .005;
      orbitPitch = Math.max(-Math.PI*.495,Math.min(Math.PI*.495,orbitPitch));
    }
    render();
  });
  const stopDrag = () => { dragging = false; };
  stage.addEventListener('pointerup', stopDrag); stage.addEventListener('pointercancel', stopDrag);
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    if (cameraMode === 'orbit') {
      orbitDistance *= Math.exp(event.deltaY * .001);
      orbitDistance = Math.max(radius * .03,Math.min(radius * 20,orbitDistance));
    } else {
      flyPosition = add(flyPosition,scale(forwardVector(),-event.deltaY * flySpeed * .002));
    }
    render();
  },{passive:false});
  document.addEventListener('mousemove', event => {
    if (cameraMode !== 'fly' || document.pointerLockElement !== canvas) return;
    flyYaw += event.movementX * .0022; flyPitch -= event.movementY * .0022;
    flyPitch = Math.max(-Math.PI*.495,Math.min(Math.PI*.495,flyPitch));
  });
  document.addEventListener('pointerlockchange', () => { updateCameraHelp(); publish({ pointerLocked:document.pointerLockElement === canvas }); });
  document.addEventListener('keydown', event => {
    if (cameraMode !== 'fly' || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if ('wasdqeshift'.includes(event.key.toLowerCase()) || event.key === 'Shift') {
      keys.add(event.key.toLowerCase()); event.preventDefault();
    }
  });
  document.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());
  new ResizeObserver(render).observe(stage);

  let previousFrame = performance.now();
  function animate(now) {
    const delta = Math.min(.05,(now - previousFrame) / 1000); previousFrame = now;
    if (cameraMode === 'fly' && keys.size) {
      const forward = forwardVector(), right = norm(cross([0,1,0],forward));
      let move = [0,0,0];
      if (keys.has('w')) move = add(move,forward); if (keys.has('s')) move = sub(move,forward);
      if (keys.has('d')) move = add(move,right); if (keys.has('a')) move = sub(move,right);
      if (keys.has('e')) move[1] += 1; if (keys.has('q')) move[1] -= 1;
      if (Math.hypot(...move)) {
        const boost = keys.has('shift') ? 4 : 1;
        flyPosition = add(flyPosition,scale(norm(move),flySpeed*boost*delta)); render();
      }
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  document.getElementById('scene-title').textContent = 'Build density in 3D';
  const biomeCopy = manifest.scope.biomes.length ? ` · ${manifest.scope.biomes.map(titleCase).join(' + ')}` : '';
  document.getElementById('scene-subtitle').textContent =
    `Snapshot #${manifest.snapshotId} · exact selection${biomeCopy} · selection-local coordinates`;
  document.getElementById('metric-pieces').textContent = fmt(manifest.pieces);
  document.getElementById('metric-dimensions').textContent = manifest.dimensionsM.map(value => `${fmt(value)} m`).join(' × ');
  document.getElementById('metric-bytes').textContent = fmtBytes(manifest.instanceBytes);
  document.getElementById('metric-adapter').textContent = adapterInfo.description || adapterInfo.device || adapterInfo.vendor || adapterClass;
  const coverage = manifest.geometryCoverage;
  document.getElementById('quality-copy').textContent =
    `${fmt(coverage.real)} measured · ${fmt(coverage.estimated)} family-estimated · ${fmt(coverage.unknown)} pivot marker${coverage.unknown === 1 ? '' : 's'}.`;
  updateCameraHelp(); setSurface(params.get('surface') === 'wire' ? 'wire' : 'shaded'); resetCamera();
  await device.queue.onSubmittedWorkDone(); await frame(); await frame();
  const startup = performance.now() - PAGE_STARTED;
  const viewHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', lastViewProjection.buffer))]
    .map(value => value.toString(16).padStart(2,'0')).join('');
  document.documentElement.dataset.sceneReady = 'true';
  statusNode.textContent = `${adapterClass.toUpperCase()} · ${startup.toFixed(1)} MS START · GRID ${grid.step} M`;
  publish({
    status:'ready', schema:'steward-scene-browser/v1', pieces:manifest.pieces,
    triangles:manifest.triangles, exact:manifest.exact, forced:manifest.forced,
    instanceBytes:manifest.instanceBytes, instanceStride:manifest.instanceStride,
    instanceSha256:manifest.instanceSha256, adapter:adapterInfo,
    adapterClassification:adapterClass, features:[...adapter.features].sort(),
    canvas:[canvas.width,canvas.height], startupMs:+startup.toFixed(2),
    drawCalls:visible.size + 1, surface, cameraMode, pointerLocked:false,
    viewMatrixSha256:viewHash, geometryCoverage:coverage,
    families:manifest.families.map(family => family.name)
  });

  async function benchmark(frameCount = manifest.benchmarkFrames || 300) {
    const intervals = [], submits = [];
    let previous = performance.now();
    for (let i = 0; i < (manifest.warmupFrames || 30); i++) {
      if (cameraMode === 'orbit') orbitYaw += .006; render(); await frame(); previous = performance.now();
    }
    for (let i = 0; i < frameCount; i++) {
      const submitted = performance.now();
      if (cameraMode === 'orbit') orbitYaw += .006;
      render(); submits.push(performance.now() - submitted);
      await frame(); const now = performance.now(); intervals.push(now - previous); previous = now;
    }
    await device.queue.onSubmittedWorkDone();
    const metrics = {
      status:'ok', samples:intervals.length,
      frameP50Ms:+percentile(intervals,.5).toFixed(2),
      frameP95Ms:+percentile(intervals,.95).toFixed(2),
      frameMaxMs:+Math.max(...intervals).toFixed(2),
      submitP95Ms:+percentile(submits,.95).toFixed(3)
    };
    statusNode.textContent = `${adapterClass.toUpperCase()} · ${metrics.frameP95Ms.toFixed(2)} MS P95 · ${fmt(manifest.pieces)} PIECES`;
    publish(metrics); return window.__stewardSceneReceipt;
  }
  window.__stewardSceneControls = { render, benchmark, setSurface, setCameraMode, resetCamera };
  if (params.get('benchmark') === '1') benchmark().catch(fail);
}

main().catch(fail);
