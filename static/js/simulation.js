document.addEventListener('DOMContentLoaded', () => {
    // Math typesetting
    if (window.renderMathInElement) {
        window.renderMathInElement(document.body, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '$', right: '$', display: false}
            ]
        });
    }

    // Tab Switching
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    const controls3d = document.getElementById('controls-3d');
    const controls2d = document.getElementById('controls-2d');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.add('hidden'));
            
            btn.classList.add('active');
            const targetTab = btn.getAttribute('data-tab');
            document.getElementById(targetTab).classList.remove('hidden');

            if (targetTab === 'tab-3d') {
                controls3d.classList.remove('hidden');
                controls2d.classList.add('hidden');
                init3D();
            } else if (targetTab === 'tab-2d') {
                controls3d.classList.add('hidden');
                controls2d.classList.remove('hidden');
                init2D();
            } else {
                controls3d.classList.add('hidden');
                controls2d.classList.add('hidden');
            }
        });
    });

    // --- State & Constants ---
    const G = 1.0;
    const c = 1.0;
    
    let simState = {
        mass: 1.0,           // M
        r_in: 6.0,          // Inner disk radius (ISCO is 6M)
        r_out: 15.0,         // Outer disk radius
        doppler: true,      // Doppler Beaming switch
        redshift: true,     // Gravitational Redshift switch
        inclination: 15 * Math.PI / 180, // Rads
        cameraRotation: 0.0, // Rads (azimuth angle)
        
        // 2D Orbit state
        r0: 10.0,            // Initial radius
        vt0: 0.32,           // Initial tangential velocity
        vr0: 0.0,            // Initial radial velocity
        particleType: 'massive', // massive or photon
        modelType: 'relativity', // relativity or newtonian
        
        // Run state
        isOrbiting: false,
        orbitPath: [],
        currentOrbitIdx: 0,
        orbitParticles: []   // active visual particles
    };

    // --- UI Parameter Syncing ---
    function syncSliders() {
        // Mass
        const mVal = parseFloat(document.getElementById('slider-mass').value);
        simState.mass = mVal;
        document.getElementById('val-mass').innerText = mVal.toFixed(1) + ' M☉';
        document.getElementById('hud-m').innerText = mVal.toFixed(1) + ' M☉';
        
        // Physical value conversion (1 solar mass BH is ~2.95km Rs)
        const kmRs = mVal * 2.953;
        document.getElementById('hud-rs').innerText = kmRs.toFixed(2) + ' km';
        
        // Limits Panel
        const Rs = 2.0 * mVal;
        const Rph = 3.0 * mVal;
        const Risco = 6.0 * mVal;
        document.getElementById('stat-rs').innerText = Rs.toFixed(2) + ' M';
        document.getElementById('stat-rph').innerText = Rph.toFixed(2) + ' M';
        document.getElementById('stat-risco').innerText = Risco.toFixed(2) + ' M';
        
        // 3D Specific
        const rin = parseFloat(document.getElementById('slider-rin').value);
        const rout = parseFloat(document.getElementById('slider-rout').value);
        simState.r_in = Math.min(rin, rout - 1.0);
        simState.r_out = Math.max(rout, rin + 1.0);
        
        document.getElementById('val-rin').innerText = simState.r_in.toFixed(1) + ' M';
        document.getElementById('val-rout').innerText = simState.r_out.toFixed(1) + ' M';
        
        // ISCO Check helper
        if (simState.r_in < Risco) {
            document.getElementById('rin-helper').innerText = "Cuidado: Disco dentro de la órbita estable ISCO (" + Risco.toFixed(1) + "M)";
            document.getElementById('rin-helper').style.color = 'var(--accent-orange)';
        } else {
            document.getElementById('rin-helper').innerText = "Estable (Fuera de ISCO = " + Risco.toFixed(1) + "M)";
            document.getElementById('rin-helper').style.color = 'var(--text-muted)';
        }

        simState.doppler = document.getElementById('switch-doppler').checked;
        simState.redshift = document.getElementById('switch-redshift').checked;
        
        const incl = parseFloat(document.getElementById('slider-inclination').value);
        simState.inclination = incl * Math.PI / 180;
        document.getElementById('val-inclination').innerText = incl + '°';

        // 2D Specific
        simState.r0 = parseFloat(document.getElementById('slider-r0').value);
        document.getElementById('val-r0').innerText = simState.r0.toFixed(1) + ' M';
        
        simState.vt0 = parseFloat(document.getElementById('slider-vt0').value);
        document.getElementById('val-vt0').innerText = simState.vt0.toFixed(2) + ' c';
        
        simState.vr0 = parseFloat(document.getElementById('slider-vr0').value);
        document.getElementById('val-vr0').innerText = simState.vr0.toFixed(2) + ' c';

        simState.particleType = document.getElementById('select-particle-type').value;
        simState.modelType = document.getElementById('select-model-type').value;

        // Recalculate potential well curve if 2D view is active
        if (tab2DActive) {
            drawPotentialWell();
        }
    }

    // Attach listeners
    const inputs = ['slider-mass', 'slider-rin', 'slider-rout', 'slider-inclination', 
                    'slider-r0', 'slider-vt0', 'slider-vr0', 'select-particle-type', 'select-model-type'];
    inputs.forEach(id => {
        document.getElementById(id).addEventListener('input', syncSliders);
        document.getElementById(id).addEventListener('change', syncSliders);
    });
    
    document.getElementById('switch-doppler').addEventListener('change', syncSliders);
    document.getElementById('switch-redshift').addEventListener('change', syncSliders);

    // --- WebGL 3D Raytracing Engine ---
    let gl = null;
    let program = null;
    let animationFrameId = null;
    let uLocations = {};
    let is3DInitialized = false;

    const vertexShaderSource = `
        attribute vec2 position;
        varying vec2 v_uv;
        void main() {
            v_uv = position * 0.5 + 0.5;
            gl_Position = vec4(position, 0.0, 1.0);
        }
    `;

    const fragmentShaderSource = `
        precision highp float;
        varying vec2 v_uv;
        
        uniform vec2 u_resolution;
        uniform float u_mass;
        uniform float u_r_in;
        uniform float u_r_out;
        uniform float u_inclination;
        uniform float u_rotation;
        uniform bool u_doppler;
        uniform bool u_redshift;
        uniform float u_time;

        #define MAX_STEPS 90
        #define STEP_SIZE 0.08

        vec3 rotateX(vec3 p, float a) {
            float c = cos(a);
            float s = sin(a);
            return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
        }

        vec3 rotateY(vec3 p, float a) {
            float c = cos(a);
            float s = sin(a);
            return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
        }

        // Pseudo-random function for noise in stars and disk
        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        void main() {
            vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
            
            float M = u_mass;
            float Rs = 2.0 * M;
            
            // Set up camera far away
            vec3 camPos = vec3(0.0, 0.0, -18.0);
            camPos = rotateX(camPos, u_inclination);
            camPos = rotateY(camPos, u_rotation);
            
            // Ray direction vector
            vec3 rayDir = normalize(vec3(uv, 1.2));
            rayDir = rotateX(rayDir, u_inclination);
            rayDir = rotateY(rayDir, u_rotation);
            
            vec3 pos = camPos;
            vec3 dir = rayDir;
            
            vec3 finalColor = vec3(0.0);
            bool hitHorizon = false;
            bool hitDisk = false;
            vec3 hitPos = vec3(0.0);
            
            // Angular momentum squared h2 = |r x v|^2
            float h2 = dot(cross(pos, dir), cross(pos, dir));
            float dt = STEP_SIZE;
            
            // Raymarching geodesic integrator
            for (int i = 0; i < MAX_STEPS; i++) {
                float r2 = dot(pos, pos);
                float r = sqrt(r2);
                
                // Event horizon capture
                if (r < Rs * 1.008) {
                    hitHorizon = true;
                    break;
                }
                
                // Intersection with accretion disk plane (y = 0)
                if (pos.y * (pos.y + dir.y * dt) < 0.0) {
                    float t = -pos.y / dir.y;
                    vec3 intersect = pos + dir * t;
                    float d = length(intersect.xz);
                    
                    if (d >= u_r_in && d <= u_r_out) {
                        hitDisk = true;
                        hitPos = intersect;
                        break;
                    }
                }
                
                // Gravitational bending acceleration (General Relativity geodesic term)
                // a = -1.5 * Rs * L^2 * pos / r^5
                vec3 gravityAcc = -1.5 * Rs * h2 * pos / (r2 * r2 * r);
                
                // Update ray direction and step forward
                dir = normalize(dir + gravityAcc * dt);
                pos += dir * dt;
                
                // Escaped to infinity
                if (r > 32.0) {
                    break;
                }
            }
            
            if (hitHorizon) {
                // Event Horizon interior is black
                finalColor = vec3(0.0);
            } else if (hitDisk) {
                float r = length(hitPos.xz);
                float phi = atan(hitPos.z, hitPos.x);
                
                // Temperature profile (T -> r^-0.75)
                float temp = pow(r / u_r_in, -0.75);
                
                // Base thermal color (Orange/Yellow glow)
                vec3 diskColor = vec3(1.0, 0.42, 0.04) * temp * 1.6;
                diskColor += vec3(0.6, 0.7, 1.0) * pow(temp, 4.0) * 0.15; // bluer core
                
                // Circular dust lanes and accretion structures
                float waves = sin(phi * 4.0 - r * 0.8 + u_time * 3.5) * 0.15 + 0.85;
                float noise = hash(vec2(floor(r * 40.0), floor(phi * 80.0))) * 0.2 + 0.8;
                diskColor *= waves * noise;
                
                // Gas transparency near limits
                float alpha = 1.0;
                if (r < u_r_in + 0.5) {
                    alpha = (r - u_r_in) / 0.5;
                } else if (r > u_r_out - 1.5) {
                    alpha = (u_r_out - r) / 1.5;
                }
                diskColor *= alpha;
                
                float redshift = 1.0;
                
                // 1. Gravitational Redshift
                if (u_redshift) {
                    redshift *= sqrt(1.0 - Rs / r);
                }
                
                // 2. Relativistic Doppler Beaming
                if (u_doppler) {
                    // Orbital velocity: v = sqrt(M/r)
                    float v = sqrt(M / r);
                    
                    // Velocity vector in equatorial plane (tangential)
                    // Disk rotates counter-clockwise from above
                    vec3 vVec = vec3(-sin(phi), 0.0, cos(phi)) * v;
                    
                    // Cosine of angle between emission ray and velocity vector
                    float cosTheta = dot(normalize(dir), normalize(vVec));
                    
                    // Doppler factor D = 1 / (gamma * (1 - v * cos(theta)))
                    float gamma = 1.0 / sqrt(1.0 - v*v);
                    float D = 1.0 / (gamma * (1.0 - v * cosTheta));
                    
                    redshift *= D;
                    
                    // Beaming intensifies light: I_obs = D^3.5 * I_em
                    diskColor *= pow(D, 3.5);
                }
                
                // Color shifting according to redshift factor
                if (redshift < 0.9) {
                    // Redshifted (cooling)
                    diskColor = mix(vec3(0.04, 0.0, 0.0), diskColor, redshift);
                    diskColor.r += (0.9 - redshift) * 0.3 * alpha;
                } else if (redshift > 1.1) {
                    // Blueshifted (heating/energized)
                    diskColor = mix(diskColor, vec3(0.1, 0.45, 1.0) * redshift, (redshift - 1.1) * 0.6);
                }
                
                finalColor = diskColor;
            } else {
                // Background sky with lensed stars
                vec3 skyDir = normalize(dir);
                float starNoise = hash(floor(skyDir.xy * 250.0));
                
                if (starNoise > 0.994) {
                    float starBrightness = hash(floor(skyDir.yx * 550.0));
                    finalColor = vec3(starBrightness);
                }
                
                // Cosmic dust glow
                finalColor += vec3(0.005, 0.008, 0.015) * (sin(skyDir.x * 2.0) * cos(skyDir.y * 2.0) * 0.5 + 0.5);
            }
            
            // Exposure mapping and gamma correction
            finalColor = 1.0 - exp(-finalColor * 1.8);
            finalColor = pow(finalColor, vec3(1.0 / 2.2));
            
            gl_FragColor = vec4(finalColor, 1.0);
        }
    `;

    function init3D() {
        if (is3DInitialized) return;
        
        const canvas = document.getElementById('canvas-3d');
        gl = canvas.getContext('webgl');
        
        if (!gl) {
            console.error("WebGL not supported. Displaying fallback.");
            canvas.style.display = 'none';
            return;
        }

        // Compile shaders
        const vs = compileShader(gl, vertexShaderSource, gl.VERTEX_SHADER);
        const fs = compileShader(gl, fragmentShaderSource, gl.FRAGMENT_SHADER);
        
        if (!vs || !fs) return;
        
        // Link program
        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error("Program link error:", gl.getProgramInfoLog(program));
            return;
        }
        
        gl.useProgram(program);

        // Quad setup
        const vertices = new Float32Array([
            -1.0, -1.0,
             1.0, -1.0,
            -1.0,  1.0,
            -1.0,  1.0,
             1.0, -1.0,
             1.0,  1.0
        ]);
        
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
        
        const positionAttr = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(positionAttr);
        gl.vertexAttribPointer(positionAttr, 2, gl.FLOAT, false, 0, 0);

        // Uniform locations
        const uniforms = ['u_resolution', 'u_mass', 'u_r_in', 'u_r_out', 
                          'u_inclination', 'u_rotation', 'u_doppler', 'u_redshift', 'u_time'];
        uniforms.forEach(name => {
            uLocations[name] = gl.getUniformLocation(program, name);
        });

        // Setup mouse drag rotation for 3D viewport
        setup3DCameraDrag(canvas);

        is3DInitialized = true;
        animate3D();
    }

    function compileShader(gl, source, type) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    function setup3DCameraDrag(canvas) {
        let isDragging = false;
        let prevMouseX = 0;
        let prevMouseY = 0;
        
        canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            prevMouseX = e.clientX;
            prevMouseY = e.clientY;
        });
        
        window.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const deltaX = e.clientX - prevMouseX;
            const deltaY = e.clientY - prevMouseY;
            
            // Adjust camera azimuth (rotation) and polar (inclination) angles
            simState.cameraRotation += deltaX * 0.007;
            
            // Convert vertical drag to inclination changes (bound it to prevent flipping)
            let currentIncl = parseFloat(document.getElementById('slider-inclination').value);
            currentIncl = Math.max(-85, Math.min(85, currentIncl - deltaY * 0.4));
            
            document.getElementById('slider-inclination').value = currentIncl.toFixed(0);
            document.getElementById('val-inclination').innerText = currentIncl.toFixed(0) + '°';
            simState.inclination = currentIncl * Math.PI / 180;
            
            prevMouseX = e.clientX;
            prevMouseY = e.clientY;
        });
    }

    function resizeCanvasToDisplaySize(canvas) {
        const displayWidth  = canvas.clientWidth;
        const displayHeight = canvas.clientHeight;
        
        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width  = displayWidth;
            canvas.height = displayHeight;
            gl.viewport(0, 0, canvas.width, canvas.height);
        }
    }

    let startTime = Date.now();
    function animate3D() {
        if (!gl || document.getElementById('tab-3d').classList.contains('hidden')) {
            cancelAnimationFrame(animationFrameId);
            return;
        }
        
        resizeCanvasToDisplaySize(gl.canvas);
        
        const time = (Date.now() - startTime) / 1000.0;
        
        // Pass variables to shaders
        gl.uniform2f(uLocations['u_resolution'], gl.canvas.width, gl.canvas.height);
        gl.uniform1f(uLocations['u_mass'], simState.mass);
        gl.uniform1f(uLocations['u_r_in'], simState.r_in);
        gl.uniform1f(uLocations['u_r_out'], simState.r_out);
        gl.uniform1f(uLocations['u_inclination'], simState.inclination);
        gl.uniform1f(uLocations['u_rotation'], simState.cameraRotation);
        gl.uniform1i(uLocations['u_doppler'], simState.doppler ? 1 : 0);
        gl.uniform1i(uLocations['u_redshift'], simState.redshift ? 1 : 0);
        gl.uniform1f(uLocations['u_time'], time);
        
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        
        animationFrameId = requestAnimationFrame(animate3D);
    }

    // --- 2D Geodesic Orbit Simulator Engine ---
    let canvas2D = null;
    let ctx2D = null;
    let canvasPotential = null;
    let ctxPotential = null;
    let tab2DActive = false;
    let animationFrameId2D = null;
    
    // Scale factor to map coordinates to screen pixels (pixels per unit M)
    let zoomFactor2D = 25.0;

    function init2D() {
        tab2DActive = true;
        
        canvas2D = document.getElementById('canvas-2d');
        ctx2D = canvas2D.getContext('2d');
        
        canvasPotential = document.getElementById('canvas-potential');
        ctxPotential = canvasPotential.getContext('2d');
        
        resize2DCanvases();
        
        // Draw initial setup
        draw2DSpace();
        drawPotentialWell();
        
        // Start loop
        if (animationFrameId2D) cancelAnimationFrame(animationFrameId2D);
        animate2D();
    }

    function resize2DCanvases() {
        if (!canvas2D) return;
        canvas2D.width = canvas2D.clientWidth;
        canvas2D.height = canvas2D.clientHeight;
        
        canvasPotential.width = canvasPotential.clientWidth;
        canvasPotential.height = canvasPotential.clientHeight;
        
        // Adjust zoom factor based on black hole mass to fit orbits nicely
        zoomFactor2D = Math.min(canvas2D.width, canvas2D.height) / 30.0;
    }

    window.addEventListener('resize', () => {
        if (tab2DActive) {
            resize2DCanvases();
            draw2DSpace();
            drawPotentialWell();
        }
    });

    // Solve geodesic derivatives step-by-step
    function getGeodesicDerivatives(state, mass, L, isMassive, isNewtonian) {
        const r = state[0];
        const phi = state[1];
        const vr = state[2];
        const Rs = 2.0 * mass;
        
        if (r <= Rs) {
            return [0.0, 0.0, 0.0];
        }
        
        const dr_dt = vr;
        const dphi_dt = L / (r * r);
        let dvr_dt = 0.0;
        
        if (isNewtonian) {
            if (isMassive) {
                // Newtonian orbit for massive particle: radial force + centrifugal
                dvr_dt = -mass / (r * r) + (L * L) / (r * r * r);
            } else {
                // Newtonian photon (bending doesn't happen unless we force it, 
                // but mathematically it just moves in straight line if mass-less)
                dvr_dt = (L * L) / (r * r * r);
            }
        } else {
            // General Relativity (Einstein - Schwarzschild)
            if (isMassive) {
                // d2r/dtau^2 = -M/r^2 + L^2/r^3 - 3*M*L^2/r^4
                dvr_dt = -mass / (r * r) + (L * L) / (r * r * r) - (3.0 * mass * L * L) / (r * r * r * r);
            } else {
                // Photon: d2r/dlambda^2 = L^2/r^3 - 3*M*L^2/r^4
                dvr_dt = (L * L) / (r * r * r) - (3.0 * mass * L * L) / (r * r * r * r);
            }
        }
        
        return [dr_dt, dphi_dt, dvr_dt];
    }

    // Single step RK4 integrator
    function rk4Step(state, dt, mass, L, isMassive, isNewtonian) {
        const k1 = getGeodesicDerivatives(state, mass, L, isMassive, isNewtonian);
        
        const state2 = [
            state[0] + 0.5 * dt * k1[0],
            state[1] + 0.5 * dt * k1[1],
            state[2] + 0.5 * dt * k1[2]
        ];
        const k2 = getGeodesicDerivatives(state2, mass, L, isMassive, isNewtonian);
        
        const state3 = [
            state[0] + 0.5 * dt * k2[0],
            state[1] + 0.5 * dt * k2[1],
            state[2] + 0.5 * dt * k2[2]
        ];
        const k3 = getGeodesicDerivatives(state3, mass, L, isMassive, isNewtonian);
        
        const state4 = [
            state[0] + dt * k3[0],
            state[1] + dt * k3[1],
            state[2] + dt * k3[2]
        ];
        const k4 = getGeodesicDerivatives(state4, mass, L, isMassive, isNewtonian);
        
        const nextState = [];
        for (let i = 0; i < 3; i++) {
            nextState[i] = state[i] + (dt / 6.0) * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
        }
        return nextState;
    }

    // Active particle class for 2D animation
    class OrbitParticle {
        constructor(r0, vr0, vt0, mass, particleType, modelType) {
            this.mass = mass;
            this.isMassive = (particleType === 'massive');
            this.isNewtonian = (modelType === 'newtonian');
            
            // Calculate L (angular momentum per unit mass)
            // L = r0 * v_theta
            this.L = r0 * vt0;
            
            // State: [r, phi, vr]
            this.state = [r0, 0.0, vr0];
            
            this.trail = [];
            this.status = 'orbiting'; // orbiting, captured, escaped
            
            this.color = this.isMassive ? 'rgba(6, 182, 212, 1)' : 'rgba(239, 68, 68, 1)';
            this.glowColor = this.isMassive ? 'rgba(6, 182, 212, 0.4)' : 'rgba(239, 68, 68, 0.4)';
            
            // Custom adaptive time step based on radius to handle extreme speeds near Rs
            this.dt = 0.05;
        }

        update() {
            if (this.status !== 'orbiting') return;
            
            const r = this.state[0];
            const Rs = 2.0 * this.mass;
            
            // Adaptive time step: smaller steps close to horizon
            this.dt = Math.max(0.001, Math.min(0.05, (r - Rs) * 0.015));
            if (this.isNewtonian) this.dt = 0.05; // Newtonian can run stable with fixed dt

            // Integrate state
            this.state = rk4Step(this.state, this.dt, this.mass, this.L, this.isMassive, this.isNewtonian);
            
            const nextR = this.state[0];
            const nextPhi = this.state[1];
            
            // Check horizons
            if (nextR <= Rs) {
                this.status = 'captured';
                return;
            }
            if (nextR > 80.0) {
                this.status = 'escaped';
                return;
            }
            
            // Store coordinate details
            const x = nextR * Math.cos(nextPhi);
            const y = nextR * Math.sin(nextPhi);
            
            this.trail.push({x, y});
            if (this.trail.length > 800) {
                this.trail.shift();
            }
        }

        draw(ctx, cx, cy) {
            // Draw trail
            if (this.trail.length > 1) {
                ctx.beginPath();
                ctx.moveTo(cx + this.trail[0].x * zoomFactor2D, cy - this.trail[0].y * zoomFactor2D);
                for (let i = 1; i < this.trail.length; i++) {
                    ctx.lineTo(cx + this.trail[i].x * zoomFactor2D, cy - this.trail[i].y * zoomFactor2D);
                }
                ctx.strokeStyle = this.color;
                ctx.lineWidth = 2;
                ctx.shadowColor = this.color;
                ctx.shadowBlur = 8;
                ctx.stroke();
                
                // Reset shadow
                ctx.shadowBlur = 0;
            }
            
            // Draw current particle position
            if (this.status === 'orbiting') {
                const r = this.state[0];
                const phi = this.state[1];
                const x = cx + r * Math.cos(phi) * zoomFactor2D;
                const y = cy - r * Math.sin(phi) * zoomFactor2D;
                
                // Glow
                ctx.beginPath();
                ctx.arc(x, y, 7, 0, 2 * Math.PI);
                ctx.fillStyle = this.glowColor;
                ctx.fill();
                
                ctx.beginPath();
                ctx.arc(x, y, 4, 0, 2 * Math.PI);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
            }
        }
    }

    function draw2DSpace() {
        if (!ctx2D) return;
        
        ctx2D.clearRect(0, 0, canvas2D.width, canvas2D.height);
        
        const cx = canvas2D.width / 2;
        const cy = canvas2D.height / 2;
        
        const M = simState.mass;
        const Rs = 2.0 * M;
        const Rph = 3.0 * M;
        const Risco = 6.0 * M;
        
        // Draw coordinate grid (circles)
        ctx2D.strokeStyle = 'rgba(255, 255, 255, 0.02)';
        ctx2D.lineWidth = 1;
        for (let r = 5; r <= 30; r += 5) {
            ctx2D.beginPath();
            ctx2D.arc(cx, cy, r * zoomFactor2D, 0, 2 * Math.PI);
            ctx2D.stroke();
        }
        
        // Draw ISCO boundary (Innermost Stable Circular Orbit)
        ctx2D.strokeStyle = 'rgba(168, 85, 247, 0.15)';
        ctx2D.lineWidth = 1.5;
        ctx2D.setLineDash([4, 4]);
        ctx2D.beginPath();
        ctx2D.arc(cx, cy, Risco * zoomFactor2D, 0, 2 * Math.PI);
        ctx2D.stroke();
        ctx2D.setLineDash([]);
        
        // Draw Photon Sphere boundary
        ctx2D.strokeStyle = 'rgba(239, 68, 68, 0.25)';
        ctx2D.lineWidth = 1.5;
        ctx2D.setLineDash([6, 3]);
        ctx2D.beginPath();
        ctx2D.arc(cx, cy, Rph * zoomFactor2D, 0, 2 * Math.PI);
        ctx2D.stroke();
        ctx2D.setLineDash([]);
        
        // Draw Event Horizon shadow
        ctx2D.beginPath();
        ctx2D.arc(cx, cy, Rs * zoomFactor2D, 0, 2 * Math.PI);
        ctx2D.fillStyle = '#000000';
        ctx2D.fill();
        ctx2D.strokeStyle = '#222';
        ctx2D.lineWidth = 1;
        ctx2D.stroke();
        
        // Event horizon glowing boundary
        ctx2D.beginPath();
        ctx2D.arc(cx, cy, Rs * zoomFactor2D, 0, 2 * Math.PI);
        ctx2D.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx2D.shadowColor = '#000000';
        ctx2D.shadowBlur = 10;
        ctx2D.lineWidth = 2;
        ctx2D.stroke();
        ctx2D.shadowBlur = 0; // reset
        
        // Labels
        ctx2D.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx2D.font = '10px Outfit';
        ctx2D.fillText("Horizonte Rs = " + Rs.toFixed(1) + "M", cx + (Rs + 0.3) * zoomFactor2D, cy + 4);
        
        ctx2D.fillStyle = 'rgba(239, 68, 68, 0.6)';
        ctx2D.fillText("Esfera Fotónica = " + Rph.toFixed(1) + "M", cx + (Rph + 0.3) * zoomFactor2D, cy - 8);
        
        ctx2D.fillStyle = 'rgba(168, 85, 247, 0.7)';
        ctx2D.fillText("ISCO = " + Risco.toFixed(1) + "M", cx + (Risco + 0.3) * zoomFactor2D, cy + 16);
    }

    function drawPotentialWell() {
        if (!ctxPotential) return;
        
        ctxPotential.clearRect(0, 0, canvasPotential.width, canvasPotential.height);
        
        const W = canvasPotential.width;
        const H = canvasPotential.height;
        const M = simState.mass;
        
        // Current particle angular momentum
        // If there's an active particle, use its L, otherwise compute from sliders
        let particle = simState.orbitParticles[simState.orbitParticles.length - 1];
        let L = particle ? particle.L : simState.r0 * simState.vt0;
        let isMassive = particle ? particle.isMassive : (simState.particleType === 'massive');
        let isNewtonian = particle ? particle.isNewtonian : (simState.modelType === 'newtonian');
        
        const Rs = 2.0 * M;
        
        // We'll map potential values to pixels.
        // For massive GR: V(r) = 1 - 2M/r + L^2/r^2 - 2ML^2/r^3
        // For Newton massive: V(r) = -M/r + L^2/(2r^2)
        // For photon GR: V(r) = (1 - 2M/r)*L^2/r^2 = L^2/r^2 - 2ML^2/r^3
        
        function potential(r) {
            if (r <= Rs) return null;
            
            if (isNewtonian) {
                if (isMassive) {
                    return -M / r + (L * L) / (2.0 * r * r);
                } else {
                    return (L * L) / (2.0 * r * r); // Flat potential for straight light line
                }
            } else {
                // Einstein Relativistic Potential
                if (isMassive) {
                    return 1.0 - (2.0 * M) / r + (L * L) / (r * r) - (2.0 * M * L * L) / (r * r * r);
                } else {
                    // Photon
                    return (L * L) / (r * r) - (2.0 * M * L * L) / (r * r * r);
                }
            }
        }
        
        // Generate potential curve points
        const points = [];
        const rMin = Rs * 1.05;
        const rMax = 20.0;
        
        let minPot = 999.0;
        let maxPot = -999.0;
        
        for (let xPixel = 0; xPixel < W; xPixel++) {
            const r = rMin + (xPixel / W) * (rMax - rMin);
            const V = potential(r);
            if (V !== null) {
                points.push({r, V, xPixel});
                if (V < minPot) minPot = V;
                if (V > maxPot) maxPot = V;
            }
        }
        
        // Define display limits for potential (Y axis)
        // Bound Y scaling so it doesn't skew to infinity near Rs
        let yMin = minPot - 0.1;
        let yMax = maxPot + 0.1;
        
        if (isMassive && !isNewtonian) {
            // Relativistic massive potential starts at 1 at infinity. Limit plot range.
            yMin = Math.min(yMin, 0.7);
            yMax = Math.min(yMax, 1.3);
            if (yMin > 0.9) yMin = 0.8;
            if (yMax < 1.1) yMax = 1.2;
        } else if (isNewtonian) {
            yMin = Math.max(-0.5, yMin);
            yMax = Math.min(0.5, yMax);
        } else {
            // Photon potential curves
            yMin = 0.0;
            yMax = Math.min(1.5 * maxPot, yMax);
        }
        
        function getPixelY(val) {
            return H - 15 - ((val - yMin) / (yMax - yMin)) * (H - 30);
        }
        
        // Draw Grid Lines / Axis
        ctxPotential.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctxPotential.lineWidth = 1;
        ctxPotential.beginPath();
        // Draw potential = 0 (or potential = 1 line for relativistic massive)
        const baseLineVal = (isMassive && !isNewtonian) ? 1.0 : 0.0;
        const baseLineY = getPixelY(baseLineVal);
        ctxPotential.moveTo(0, baseLineY);
        ctxPotential.lineTo(W, baseLineY);
        ctxPotential.stroke();
        
        // Draw the Potential Curve
        if (points.length > 0) {
            ctxPotential.beginPath();
            let first = true;
            points.forEach(pt => {
                const py = getPixelY(pt.V);
                if (py >= 0 && py <= H) {
                    if (first) {
                        ctxPotential.moveTo(pt.xPixel, py);
                        first = false;
                    } else {
                        ctxPotential.lineTo(pt.xPixel, py);
                    }
                }
            });
            
            ctxPotential.strokeStyle = 'rgba(168, 85, 247, 1)';
            ctxPotential.lineWidth = 2.5;
            ctxPotential.stroke();
        }
        
        // Draw critical distances (vertical lines)
        const criticalR = [
            {r: Rs, label: 'Rs', color: 'rgba(255,255,255,0.2)'},
            {r: 3.0*M, label: '3M', color: 'rgba(239, 68, 68, 0.25)'},
            {r: 6.0*M, label: '6M', color: 'rgba(168, 85, 247, 0.25)'}
        ];
        
        ctxPotential.font = '8px Outfit';
        criticalR.forEach(crit => {
            if (crit.r > rMin && crit.r < rMax) {
                const px = ((crit.r - rMin) / (rMax - rMin)) * W;
                ctxPotential.strokeStyle = crit.color;
                ctxPotential.beginPath();
                ctxPotential.moveTo(px, 10);
                ctxPotential.lineTo(px, H - 15);
                ctxPotential.stroke();
                
                ctxPotential.fillStyle = crit.color;
                ctxPotential.fillText(crit.label, px - 5, H - 4);
            }
        });
        
        // Draw current energy state E of the particle
        // Calculate Energy E based on current sliders
        let currentR = particle ? particle.state[0] : simState.r0;
        let currentVr = particle ? particle.state[2] : simState.vr0;
        let currentVt = particle ? (particle.L / currentR) : simState.vt0;
        
        let E = 0.0;
        if (isNewtonian) {
            // Newtonian E = 1/2 v^2 - GM/r
            E = 0.5 * (currentVr * currentVr + currentVt * currentVt) - M / currentR;
        } else {
            // Relativistic energy squared: E^2 = vr^2 + (1-Rs/r)*(1 + L^2/r^2)
            const factor = 1.0 - Rs / currentR;
            if (isMassive) {
                E = Math.sqrt(Math.max(0, currentVr * currentVr + factor * (1.0 + (L * L) / (currentR * currentR))));
            } else {
                // Photon E^2 = vr^2 + factor*L^2/r^2
                E = Math.sqrt(Math.max(0, currentVr * currentVr + factor * (L * L) / (currentR * currentR)));
            }
        }
        
        // Convert energy representation to potential scale
        let ePlot = isNewtonian ? E : (isMassive ? E : E*E); // For photons we plot E^2 since potential scales as (1-Rs/r)*L^2/r^2
        const ePixelY = getPixelY(ePlot);
        
        if (ePixelY >= 0 && ePixelY <= H) {
            ctxPotential.strokeStyle = 'rgba(56, 189, 248, 0.6)';
            ctxPotential.lineWidth = 1.5;
            ctxPotential.setLineDash([2, 2]);
            ctxPotential.beginPath();
            ctxPotential.moveTo(0, ePixelY);
            ctxPotential.lineTo(W, ePixelY);
            ctxPotential.stroke();
            ctxPotential.setLineDash([]);
            
            ctxPotential.fillStyle = 'rgba(56, 189, 248, 0.8)';
            ctxPotential.fillText(isNewtonian ? "Energía E" : "Energía E" + (isMassive ? "" : "²"), 5, ePixelY - 4);
        }
        
        // Draw rolling dot showing current particle position in potential well
        if (currentR > rMin && currentR < rMax) {
            const dotX = ((currentR - rMin) / (rMax - rMin)) * W;
            const ptVal = potential(currentR);
            if (ptVal !== null) {
                const dotY = getPixelY(ptVal);
                
                ctxPotential.beginPath();
                ctxPotential.arc(dotX, dotY, 5, 0, 2 * Math.PI);
                ctxPotential.fillStyle = 'rgba(6, 182, 212, 1)';
                ctxPotential.shadowColor = 'rgba(6, 182, 212, 0.6)';
                ctxPotential.shadowBlur = 6;
                ctxPotential.fill();
                ctxPotential.shadowBlur = 0; // reset
            }
        }
    }

    function animate2D() {
        if (!tab2DActive || document.getElementById('tab-2d').classList.contains('hidden')) {
            cancelAnimationFrame(animationFrameId2D);
            return;
        }

        const cx = canvas2D.width / 2;
        const cy = canvas2D.height / 2;
        
        draw2DSpace();
        
        // Integrate and draw active particles
        simState.orbitParticles.forEach(particle => {
            // Update 3 times per frame for smoother math integration
            particle.update();
            particle.update();
            particle.update();
            
            particle.draw(ctx2D, cx, cy);
        });
        
        // Filter out captured/escaped particles to keep screen tidy
        simState.orbitParticles = simState.orbitParticles.filter(p => p.status === 'orbiting');
        
        // Draw historical path returned from server if orbiting
        if (simState.isOrbiting && simState.orbitPath.length > 0) {
            ctx2D.beginPath();
            ctx2D.moveTo(cx + simState.orbitPath[0].x * zoomFactor2D, cy - simState.orbitPath[0].y * zoomFactor2D);
            
            // Draw path up to current index
            const drawLimit = Math.min(simState.currentOrbitIdx, simState.orbitPath.length);
            for (let i = 1; i < drawLimit; i++) {
                ctx2D.lineTo(cx + simState.orbitPath[i].x * zoomFactor2D, cy - simState.orbitPath[i].y * zoomFactor2D);
            }
            
            ctx2D.strokeStyle = 'rgba(255, 255, 255, 0.4)';
            ctx2D.lineWidth = 1.5;
            ctx2D.setLineDash([2, 4]);
            ctx2D.stroke();
            ctx2D.setLineDash([]);
            
            // Draw current server-computed particle
            if (simState.currentOrbitIdx < simState.orbitPath.length) {
                const pInfo = simState.orbitPath[simState.currentOrbitIdx];
                const px = cx + pInfo.x * zoomFactor2D;
                const py = cy - pInfo.y * zoomFactor2D;
                
                ctx2D.beginPath();
                ctx2D.arc(px, py, 6, 0, 2 * Math.PI);
                ctx2D.fillStyle = '#ffffff';
                ctx2D.shadowColor = '#ffffff';
                ctx2D.shadowBlur = 8;
                ctx2D.fill();
                ctx2D.shadowBlur = 0;
                
                // Print HUD details
                document.getElementById('hud-coords').innerText = `r = ${pInfo.r.toFixed(2)}M, φ = ${(pInfo.phi * 180 / Math.PI).toFixed(0)}°`;
                
                // Slow down playback slightly
                simState.currentOrbitIdx += 2;
            } else {
                simState.isOrbiting = false; // completed playback
            }
        }
        
        // Update potential energy curves
        drawPotentialWell();

        animationFrameId2D = requestAnimationFrame(animate2D);
    }

    // --- Interactive Buttons handlers ---
    document.getElementById('btn-launch').addEventListener('click', () => {
        // Launch a new local live particle
        const p = new OrbitParticle(
            simState.r0,
            simState.vr0,
            simState.vt0,
            simState.mass,
            simState.particleType,
            simState.modelType
        );
        simState.orbitParticles.push(p);

        // Fetch high-fidelity mathematical path calculated in python backend
        const url = `/api/simulate-orbit?m=${simState.mass}&r0=${simState.r0}&vr0=${simState.vr0}&vt0=${simState.vt0}&type=${simState.particleType}&steps=1500&dt=0.08`;
        
        fetch(url)
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    simState.orbitPath = data.path;
                    simState.currentOrbitIdx = 0;
                    simState.isOrbiting = true;
                    
                    // Update HUD with angular momentum
                    const L = simState.r0 * simState.vt0;
                    document.getElementById('hud-momentum').innerText = L.toFixed(2);
                    document.getElementById('hud-model-type').innerText = (simState.modelType === 'relativity' ? 'Relativista (GR)' : 'Newtoniano');
                } else {
                    console.error("Backend orbit solver error:", data.error);
                }
            })
            .catch(err => {
                console.error("Failed to connect to Python backend:", err);
            });
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
        simState.orbitParticles = [];
        simState.orbitPath = [];
        simState.isOrbiting = false;
        document.getElementById('hud-coords').innerText = `r = 10.0M, φ = 0°`;
    });

    // --- Initialize default views ---
    syncSliders();
    init3D();
});
