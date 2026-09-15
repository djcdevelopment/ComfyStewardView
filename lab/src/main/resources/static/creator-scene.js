export const CREATOR_SCENE_RENDERER = "comfy-steward-creator-renderer/v1";

const text = new TextDecoder();
const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

export async function parseCreatorScene(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 20 || text.decode(bytes.subarray(0, 4)) !== "SVCA")
    throw new Error("creator_scene_magic_invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true), manifestLength = view.getUint32(8, true);
  const instanceOffset = view.getUint32(12, true), identityOffset = view.getUint32(16, true);
  if (version !== 1 || !manifestLength || manifestLength > 1048576 ||
      instanceOffset < 20 + manifestLength || instanceOffset % 4 ||
      identityOffset < instanceOffset || identityOffset > bytes.byteLength)
    throw new Error("creator_scene_layout_invalid");
  let manifest;
  try { manifest = JSON.parse(text.decode(bytes.subarray(20, 20 + manifestLength))); }
  catch { throw new Error("creator_scene_manifest_invalid"); }
  const count = manifest.renderInstances, instanceBytes = manifest.instanceBytes;
  const identityBytes = manifest.identityBytes;
  if (manifest.schema !== "steward-zdo-authoring-scene/v1" ||
      !Number.isInteger(count) || count < 0 || count > 500000 ||
      instanceBytes !== count * 80 || manifest.identityStride !== 4 ||
      manifest.identityCount !== count || identityBytes !== count * 4 ||
      identityOffset !== instanceOffset + instanceBytes ||
      bytes.byteLength !== identityOffset + identityBytes ||
      !finite3(manifest.absoluteOrigin))
    throw new Error("creator_scene_manifest_invalid");
  const [instanceHash, identityHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", bytes.subarray(instanceOffset, identityOffset)),
    crypto.subtle.digest("SHA-256", bytes.subarray(identityOffset))
  ]);
  if (hex(new Uint8Array(instanceHash)) !== String(manifest.instanceSha256).toLowerCase() ||
      hex(new Uint8Array(identityHash)) !== String(manifest.identitySha256).toLowerCase())
    throw new Error("creator_scene_integrity_mismatch");
  return {
    manifest,
    instances: bytes.slice(instanceOffset, identityOffset),
    identities: bytes.slice(identityOffset)
  };
}

// Photography uses the public read-only scene, with anonymous instance identities.
// It never calls the Creator authoring endpoint or imports gameplay targets.
export async function parseCaptureScene(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 16 || text.decode(bytes.subarray(0,4)) !== 'SV3D') throw Error('capture_scene_magic_invalid');
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const length=view.getUint32(8,true),offset=view.getUint32(12,true);
  if (view.getUint32(4,true)!==2 || length>1048576 || offset<16+length || offset%4 || offset>bytes.length) throw Error('capture_scene_layout_invalid');
  const manifest=JSON.parse(text.decode(bytes.subarray(16,16+length)));
  if (manifest.schema!=='steward-zdo-scene/v2' || !Number.isInteger(manifest.renderInstances) || manifest.renderInstances<0 || manifest.renderInstances>500000 || manifest.instanceStride!==80 || manifest.instanceBytes!==manifest.renderInstances*80 || offset+manifest.instanceBytes!==bytes.length || !finite3(manifest.rndCameraOrigin)) throw Error('capture_scene_manifest_invalid');
  if (hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.subarray(offset))))!==manifest.instanceSha256) throw Error('capture_scene_integrity_mismatch');
  manifest.absoluteOrigin=[...manifest.rndCameraOrigin];
  const identities=new Uint32Array(manifest.renderInstances);
  for(let i=0;i<identities.length;i++) identities[i]=i;
  return {manifest,instances:bytes.slice(offset),identities:new Uint8Array(identities.buffer)};
}

const perspective = (fovy, aspect, near, far) => {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far), out = new Float32Array(16);
  out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf;
  out[11] = -1; out[14] = 2 * far * near * nf;
  return out;
};
const lookAt = (eye, center, up = [0,1,0]) => {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1; zx /= len; zy /= len; zz /= len;
  let xx = up[1]*zz-up[2]*zy, xy = up[2]*zx-up[0]*zz, xz = up[0]*zy-up[1]*zx;
  len = Math.hypot(xx,xy,xz) || 1; xx /= len; xy /= len; xz /= len;
  const yx = zy*xz-zz*xy, yy = zz*xx-zx*xz, yz = zx*xy-zy*xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1
  ]);
};
const multiply = (a, b) => {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++)
    out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] +
      a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
  return out;
};

export async function mountCreatorScene(canvas, input, onSelection = () => {}, options = {}) {
  if (!navigator.gpu) throw new Error("webgpu_unavailable");
  const scene = await (options.capture ? parseCaptureScene(input) : parseCreatorScene(input));
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("webgpu_adapter_unavailable");
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const shader = device.createShaderModule({ code: `
struct Camera { viewProjection: mat4x4<f32>, selected: u32, pad0: u32, pad1: u32, pad2: u32 }
struct Instance { model: mat4x4<f32>, color: vec4f }
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> identities: array<u32>;
const cube = array<vec3f, 36>(
 vec3f(-.5,-.5,.5),vec3f(.5,-.5,.5),vec3f(.5,.5,.5),vec3f(-.5,-.5,.5),vec3f(.5,.5,.5),vec3f(-.5,.5,.5),
 vec3f(.5,-.5,-.5),vec3f(-.5,-.5,-.5),vec3f(-.5,.5,-.5),vec3f(.5,-.5,-.5),vec3f(-.5,.5,-.5),vec3f(.5,.5,-.5),
 vec3f(-.5,-.5,-.5),vec3f(-.5,-.5,.5),vec3f(-.5,.5,.5),vec3f(-.5,-.5,-.5),vec3f(-.5,.5,.5),vec3f(-.5,.5,-.5),
 vec3f(.5,-.5,.5),vec3f(.5,-.5,-.5),vec3f(.5,.5,-.5),vec3f(.5,-.5,.5),vec3f(.5,.5,-.5),vec3f(.5,.5,.5),
 vec3f(-.5,.5,.5),vec3f(.5,.5,.5),vec3f(.5,.5,-.5),vec3f(-.5,.5,.5),vec3f(.5,.5,-.5),vec3f(-.5,.5,-.5),
 vec3f(-.5,-.5,-.5),vec3f(.5,-.5,-.5),vec3f(.5,-.5,.5),vec3f(-.5,-.5,-.5),vec3f(.5,-.5,.5),vec3f(-.5,-.5,.5));
struct VertexOut { @builtin(position) position: vec4f, @location(0) color: vec4f,
 @location(1) @interpolate(flat) identity: u32, @location(2) @interpolate(flat) slot: u32 }
@vertex fn vertex(@builtin(vertex_index) vertexIndex: u32,
 @builtin(instance_index) instanceIndex: u32) -> VertexOut {
 var out: VertexOut; let item = instances[instanceIndex];
 out.position = camera.viewProjection * item.model * vec4f(cube[vertexIndex], 1);
 out.color = item.color; out.identity = identities[instanceIndex]; out.slot = instanceIndex + 1;
 return out;
}
@fragment fn shade(input: VertexOut) -> @location(0) vec4f {
 if (camera.selected != 0xffffffffu && input.identity == camera.selected) {
   return vec4f(mix(input.color.rgb, vec3f(1.0,.72,.12), .75), 1);
 }
 return vec4f(input.color.rgb * .82 + vec3f(.06), 1);
}
@fragment fn pick(input: VertexOut) -> @location(0) u32 { return input.slot; }` });
  const bindGroupLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.VERTEX,
      buffer: { type: "read-only-storage" } }
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeline = device.createRenderPipeline({
    layout, vertex: { module: shader, entryPoint: "vertex" },
    fragment: { module: shader, entryPoint: "shade", targets: [{ format }] },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" }
  });
  const pickPipeline = device.createRenderPipeline({
    layout, vertex: { module: shader, entryPoint: "vertex" },
    fragment: { module: shader, entryPoint: "pick", targets: [{ format: "r32uint" }] },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" }
  });
  const instanceBuffer = device.createBuffer({
    size: Math.max(4, scene.instances.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const identityBuffer = device.createBuffer({
    size: Math.max(4, scene.identities.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  if (scene.instances.byteLength) device.queue.writeBuffer(instanceBuffer, 0, scene.instances);
  if (scene.identities.byteLength) device.queue.writeBuffer(identityBuffer, 0, scene.identities);
  const uniformBuffer = device.createBuffer({
    size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout, entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: instanceBuffer } },
      { binding: 2, resource: { buffer: identityBuffer } }
    ]
  });
  const identities = new Uint32Array(scene.identities.buffer,
    scene.identities.byteOffset, scene.identities.byteLength / 4);
  const target = [...(scene.manifest.home?.target || [0, 0, 0])];
  let yaw = .7, pitch = .5, distance = Math.max(12, Number(scene.manifest.home?.radiusM || 5) * 2.5);
  let selected = 0xffffffff, depth, pickTexture, frame = 0, disposed = false;
  let externalCamera = null, interactive = true, lastCamera = null, lastMatrix = null;

  const resize = () => {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (depth && pickTexture && canvas.width === width && canvas.height === height) return;
    canvas.width = width; canvas.height = height;
    depth?.destroy(); pickTexture?.destroy();
    depth = device.createTexture({ size: [width, height], format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT });
    pickTexture = device.createTexture({ size: [width, height], format: "r32uint",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  };
  const cameraBytes = () => {
    const eye = [target[0] + distance * Math.cos(pitch) * Math.sin(yaw),
      target[1] + distance * Math.sin(pitch),
      target[2] + distance * Math.cos(pitch) * Math.cos(yaw)];
    lastCamera = externalCamera || {eye,target:[...target],up:[0,1,0],verticalFov:60,aspect:canvas.width/canvas.height};
    const vp = multiply(perspective(lastCamera.verticalFov*Math.PI/180, lastCamera.aspect, .05,
      Math.max(20000, distance * 20)), lookAt(lastCamera.eye, lastCamera.target, lastCamera.up));
    lastMatrix = vp;
    const data = new ArrayBuffer(80); new Float32Array(data, 0, 16).set(vp);
    new DataView(data).setUint32(64, selected, true); return data;
  };
  const pass = (encoder, view, picking = false) => {
    const render = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: picking ? { r: 0, g: 0, b: 0, a: 0 } :
        { r: .025, g: .035, b: .055, a: 1 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1,
        depthLoadOp: "clear", depthStoreOp: "store" }
    });
    render.setPipeline(picking ? pickPipeline : pipeline); render.setBindGroup(0, bindGroup);
    render.draw(36, scene.manifest.renderInstances); render.end();
  };
  const draw = () => {
    if (disposed) return; resize(); device.queue.writeBuffer(uniformBuffer, 0, cameraBytes());
    const encoder = device.createCommandEncoder(); pass(encoder, context.getCurrentTexture().createView());
    device.queue.submit([encoder.finish()]);
    options.onView?.(lastMatrix);
  };
  const requestDraw = () => { if (disposed) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
  const observer = new ResizeObserver(requestDraw); observer.observe(canvas);
  const events = new AbortController();
  let drag = null, moved = false;
  canvas.addEventListener("pointerdown", event => {
    if (!interactive) return;
    drag = [event.clientX, event.clientY]; moved = false; canvas.setPointerCapture(event.pointerId);
  }, { signal: events.signal });
  canvas.addEventListener("pointermove", event => {
    if (!drag) return; const dx = event.clientX - drag[0], dy = event.clientY - drag[1];
    moved ||= Math.abs(dx) + Math.abs(dy) > 2; drag = [event.clientX, event.clientY];
    yaw -= dx * .007; pitch = Math.max(-1.45, Math.min(1.45, pitch + dy * .007)); requestDraw();
  }, { signal: events.signal });
  canvas.addEventListener("pointerup", async event => {
    drag = null; if (moved || disposed || !scene.manifest.renderInstances) return;
    resize(); device.queue.writeBuffer(uniformBuffer, 0, cameraBytes());
    const x = Math.max(0, Math.min(canvas.width - 1,
      Math.floor((event.clientX - canvas.getBoundingClientRect().left) * canvas.width / canvas.clientWidth)));
    const y = Math.max(0, Math.min(canvas.height - 1,
      Math.floor((event.clientY - canvas.getBoundingClientRect().top) * canvas.height / canvas.clientHeight)));
    const read = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder(); pass(encoder, pickTexture.createView(), true);
      encoder.copyTextureToBuffer({ texture: pickTexture, origin: { x, y } },
        { buffer: read, bytesPerRow: 256 }, { width: 1, height: 1 });
      device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
      if (disposed) return;
      const slot = new Uint32Array(read.getMappedRange())[0];
      if (slot) { selected = identities[slot - 1];
        const values=new Float32Array(scene.instances.buffer,scene.instances.byteOffset+(slot-1)*80,20);
        // Exact ray/box intersection against the same transformed cube the renderer draws.
        const position=pickSurface(values,lastCamera,(x+.5)/canvas.width,(y+.5)/canvas.height);
        onSelection({zdoIndex: selected, instanceIndex: slot - 1, position, manifest: scene.manifest }); requestDraw(); }
    } catch (error) {
      if (!disposed) onSelection({ error: "webgpu_pick_failed" });
    } finally {
      if (read.mapState === "mapped") read.unmap();
      read.destroy();
    }
  }, { signal: events.signal });
  canvas.addEventListener("wheel", event => {
    if (!interactive) return;
    event.preventDefault(); distance = Math.max(.5, Math.min(25000, distance * Math.exp(event.deltaY * .001)));
    requestDraw();
  }, { passive: false, signal: events.signal });
  device.lost.then(() => { if (!disposed) onSelection({ error: "webgpu_device_lost" }); });
  requestDraw();
  return { scene, setCamera(value) { externalCamera=value; requestDraw(); },
    setInteractive(value) { interactive=value; drag=null; },
    view() { return {camera:lastCamera,matrix:lastMatrix}; },
    reset() { yaw = .7; pitch = .5;
    distance = Math.max(12, Number(scene.manifest.home?.radiusM || 5) * 2.5); requestDraw(); },
    dispose() { disposed = true; events.abort(); observer.disconnect(); cancelAnimationFrame(frame);
      instanceBuffer.destroy(); identityBuffer.destroy(); uniformBuffer.destroy(); depth?.destroy(); pickTexture?.destroy();
      device.destroy(); } };
}

function pickSurface(m,c,u,v) {
  const norm=a=>{const n=Math.hypot(...a)||1;return a.map(x=>x/n);};
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  const forward=norm(c.target.map((x,i)=>x-c.eye[i])),right=norm(cross(forward,c.up)),up=cross(right,forward);
  const h=Math.tan(c.verticalFov*Math.PI/360);
  const ray=norm(forward.map((x,i)=>x+right[i]*(2*u-1)*h*c.aspect+up[i]*(1-2*v)*h));
  const a=[m[0],m[1],m[2]],b=[m[4],m[5],m[6]],d=[m[8],m[9],m[10]],det=dot(a,cross(b,d));
  if(Math.abs(det)<1e-12) return null;
  const inverse=[cross(b,d),cross(d,a),cross(a,b)].map(row=>row.map(x=>x/det));
  const eye=c.eye.map((x,i)=>x-m[12+i]),o=inverse.map(row=>dot(row,eye)),dir=inverse.map(row=>dot(row,ray));
  let near=0,far=Infinity;
  for(let i=0;i<3;i++) {
    if(Math.abs(dir[i])<1e-12) {if(Math.abs(o[i])>.5)return null;continue;}
    const t1=(-.5-o[i])/dir[i],t2=(.5-o[i])/dir[i];
    near=Math.max(near,Math.min(t1,t2));far=Math.min(far,Math.max(t1,t2));
  }
  return far<near?null:c.eye.map((x,i)=>x+near*ray[i]);
}
