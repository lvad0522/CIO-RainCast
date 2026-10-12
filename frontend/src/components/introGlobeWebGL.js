import { geoEquirectangular, geoGraticule10, geoPath } from 'd3-geo';

// Rasterize geography once. Rotation then changes two uniforms rather than
// projecting thousands of coastline vertices on the main thread each frame.
const maps = new WeakMap();
function globeMap(land, width) {
  let sizes = maps.get(land);
  if (!sizes) { sizes = new Map(); maps.set(land, sizes); }
  if (sizes.has(width)) return sizes.get(width);
  const map = document.createElement('canvas');
  map.width = width;
  map.height = width / 2;
  const ctx = map.getContext('2d');
  if (!ctx) throw new Error('Globe texture unavailable');
  const projection = geoEquirectangular()
    .translate([width / 2, width / 4])
    .scale(width / (2 * Math.PI));
  const path = geoPath(projection, ctx);
  ctx.beginPath();
  path(land);
  ctx.fillStyle = '#386773';
  ctx.fill();
  ctx.strokeStyle = 'rgba(167, 210, 212, .74)';
  ctx.lineWidth = width / 2800;
  ctx.stroke();
  ctx.beginPath();
  path(geoGraticule10());
  ctx.strokeStyle = 'rgba(97, 169, 199, .24)';
  ctx.lineWidth = width / 3800;
  ctx.stroke();
  sizes.set(width, map);
  return map;
}

const VERTEX = `
attribute vec2 aPosition;
varying vec2 vPosition;
void main() {
  vPosition = aPosition;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
varying vec2 vPosition;
uniform sampler2D uMap;
uniform vec2 uLongitude;
uniform vec2 uGlow;
uniform vec2 uPixels;
uniform float uEmphasis;
const float PI = 3.141592653589793;
const float RADIUS = 0.448;

float radial(vec2 p, vec2 c0, float r0, vec2 c1, float r1) {
  vec2 d = c1 - c0;
  vec2 q = p - c0;
  float dr = r1 - r0;
  float a = dot(d, d) - dr * dr;
  float b = -2.0 * (dot(q, d) + r0 * dr);
  float c = dot(q, q) - r0 * r0;
  return clamp((-b - sqrt(max(0.0, b*b - 4.0*a*c))) / (2.0*a), 0.0, 1.0);
}

void main() {
  vec2 p = vec2(vPosition.x, -vPosition.y) * 0.5 + 0.5;
  float distance = length(p - 0.5);
  float haloT = clamp((distance / RADIUS - 0.93) / 0.17, 0.0, 1.0);
  float haloAlpha = 0.14 * (haloT < 0.48 ? haloT / 0.48 : (1.0-haloT) / 0.52);
  vec3 haloColor = vec3(76.0, 155.0, 181.0) / 255.0;
  vec3 color = haloColor;
  float coverage = 1.0 - smoothstep(RADIUS-uPixels.y, RADIUS+uPixels.y, distance);
  if (coverage > 0.0) {
    vec2 xy = vPosition / (2.0 * RADIUS);
    float z = sqrt(max(0.0, 1.0 - dot(xy, xy)));
    // Camera points at longitude uLongitude and latitude 25 degrees.
    float north = xy.y * 0.906307787 + z * 0.422618262;
    float forward = z * 0.906307787 - xy.y * 0.422618262;
    vec3 world = vec3(
      xy.x*uLongitude.y + forward*uLongitude.x,
      north,
      forward*uLongitude.y - xy.x*uLongitude.x
    );
    vec2 uv = vec2(0.5 + atan(world.x, world.z)/(2.0*PI), 0.5 - asin(clamp(world.y,-1.0,1.0))/PI);
    vec4 geography = texture2D(uMap, uv);
    float oceanT = radial(p, vec2(0.31,0.27), RADIUS*0.1, vec2(0.5), RADIUS*1.15);
    vec3 ocean = oceanT < 0.62
      ? mix(vec3(21.0,66.0,92.0), vec3(13.0,48.0,72.0), oceanT/0.62)/255.0
      : mix(vec3(13.0,48.0,72.0), vec3(8.0,30.0,48.0), (oceanT-0.62)/0.38)/255.0;
    color = mix(ocean, geography.rgb, geography.a);
    float shadeT = radial(p, vec2(0.3,0.26), 0.0, vec2(0.5), RADIUS*1.1);
    if (shadeT < 0.67) color = mix(color, vec3(199.0,230.0,230.0)/255.0, 0.07*(1.0-shadeT/0.67));
    else color = mix(color, vec3(3.0,13.0,25.0)/255.0, 0.49*(shadeT-0.67)/0.33);
    float glow = max(0.0, 1.0-length(p-uGlow)/(RADIUS*0.24)) * 0.16 * uEmphasis;
    color = mix(color, vec3(124.0,222.0,215.0)/255.0, glow);
  }
  float alpha = mix(haloAlpha, 1.0, coverage);
  float border = 0.62 * (1.0-smoothstep(uPixels.x*0.5, uPixels.x*0.5+uPixels.y, abs(distance-RADIUS)));
  float finalAlpha = border + alpha*(1.0-border);
  color = (vec3(136.0,206.0,223.0)/255.0*border + color*alpha*(1.0-border)) / max(finalAlpha, 0.00001);
  gl_FragColor = vec4(color, finalAlpha);
}`;

function shader(gl, type, source) {
  const result = gl.createShader(type);
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(result);
    gl.deleteShader(result);
    throw new Error(message || 'Globe shader unavailable');
  }
  return result;
}

export function createGlobeWebGLPainter(canvas, land) {
  const gl = canvas.getContext('webgl', {
    alpha: true, premultipliedAlpha: false, antialias: false,
    depth: false, stencil: false,
  });
  if (!gl) return null;
  let program, buffer, texture, vertex, fragment;
  const dispose = () => {
    if (texture) gl.deleteTexture(texture);
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  try {
    vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
    fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Globe program unavailable');
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const width = Math.min(4096, 2 ** Math.floor(Math.log2(gl.getParameter(gl.MAX_TEXTURE_SIZE))));
    texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Canvas row zero is north; shader v=0 deliberately samples north.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, globeMap(land, width));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.uniform1i(gl.getUniformLocation(program, 'uMap'), 0);
    const longitudeUniform = gl.getUniformLocation(program, 'uLongitude');
    const glowUniform = gl.getUniformLocation(program, 'uGlow');
    const pixelsUniform = gl.getUniformLocation(program, 'uPixels');
    const emphasisUniform = gl.getUniformLocation(program, 'uEmphasis');
    return {
      resize(size, dpr) {
        canvas.width = Math.round(size*dpr);
        canvas.height = canvas.width;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(pixelsUniform, 1/size, 0.5/canvas.width);
      },
      paint(longitude, emphasis) {
        const angle = longitude*Math.PI/180;
        const delta = (115-longitude)*Math.PI/180;
        gl.uniform2f(longitudeUniform, Math.sin(angle), Math.cos(angle));
        gl.uniform2f(glowUniform,
          0.5 + .448*.882947593*Math.sin(delta),
          0.5 - .448*(.469471563*.906307787-.882947593*Math.cos(delta)*.422618262));
        gl.uniform1f(emphasisUniform, emphasis);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}
