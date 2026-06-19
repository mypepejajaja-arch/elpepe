import os
import math
from flask import Flask, render_template, jsonify, request

app = Flask(__name__)

# Constants in geometric units (G = c = 1)
# These equations govern Schwarzschild geodesics.

def integrate_geodesic(m, r0, vr0, vt0, particle_type='massive', step_size=0.05, max_steps=1000):
    """
    Integrates the Schwarzschild geodesic equations of motion using RK4.
    
    Parameters:
    - m: Mass of the black hole (determines Schwarzschild radius Rs = 2M)
    - r0: Initial radial coordinate (r > Rs)
    - vr0: Initial radial velocity (dr/dtau or dr/dlambda)
    - vt0: Initial tangential velocity (r * dphi/dtau or r * dphi/dlambda)
    - particle_type: 'massive' (matter) or 'photon' (light)
    
    Equations:
    For massive particles:
      d2r/dtau2 = -M/r^2 + L^2/r^3 - 3*M*L^2/r^4
      dphi/dtau = L/r^2
    For photons:
      d2r/dlambda2 = L^2/r^3 - 3*M*L^2/r^4
      dphi/dlambda = L/r^2
    """
    # Calculate angular momentum per unit mass L = r * vt0
    L = r0 * vt0
    Rs = 2.0 * m
    
    # If starting inside or too close to event horizon, stop immediately
    if r0 <= Rs:
        return []
    
    # State: [r, phi, p_r] where p_r = dr/dtau (or dr/dlambda)
    # We start at phi = 0
    state = [r0, 0.0, vr0]
    
    path = []
    
    # Derivatives function
    def derivatives(s):
        r, phi, p_r = s
        if r <= Rs:
            return [0.0, 0.0, 0.0]
            
        dr_dtau = p_r
        dphi_dtau = L / (r * r)
        
        # Radial acceleration
        if particle_type == 'massive':
            # Relativistic radial acceleration for matter
            dp_r_dtau = -m / (r * r) + (L * L) / (r * r * r) - (3.0 * m * L * L) / (r * r * r * r)
        else:
            # Relativistic radial acceleration for light (massless)
            dp_r_dtau = (L * L) / (r * r * r) - (3.0 * m * L * L) / (r * r * r * r)
            
        return [dr_dtau, dphi_dtau, dp_r_dtau]

    # Runge-Kutta 4th Order integration
    dt = step_size
    for step in range(max_steps):
        r, phi, p_r = state
        
        # Check boundary conditions
        if r <= Rs:
            # Particle captured by Event Horizon
            path.append({
                "r": float(r),
                "phi": float(phi),
                "x": 0.0,
                "y": 0.0,
                "status": "captured"
            })
            break
            
        if r > 100.0 * r0:
            # Particle escaped to infinity
            path.append({
                "r": float(r),
                "phi": float(phi),
                "x": float(r * math.cos(phi)),
                "y": float(r * math.sin(phi)),
                "status": "escaped"
            })
            break
            
        # Store current position
        x = r * math.cos(phi)
        y = r * math.sin(phi)
        path.append({
            "r": float(r),
            "phi": float(phi),
            "x": float(x),
            "y": float(y),
            "status": "orbiting"
        })
        
        # RK4 Steps
        k1 = derivatives(state)
        
        state_k2 = [state[i] + 0.5 * dt * k1[i] for i in range(3)]
        k2 = derivatives(state_k2)
        
        state_k3 = [state[i] + 0.5 * dt * k2[i] for i in range(3)]
        k3 = derivatives(state_k3)
        
        state_k4 = [state[i] + dt * k3[i] for i in range(3)]
        k4 = derivatives(state_k4)
        
        # Update state
        for i in range(3):
            state[i] += (dt / 6.0) * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i])
            
    return path

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/simulate-orbit', methods=['GET'])
def api_simulate_orbit():
    try:
        m = float(request.args.get('m', 1.0))
        r0 = float(request.args.get('r0', 10.0))
        vr0 = float(request.args.get('vr0', 0.0))
        vt0 = float(request.args.get('vt0', 0.3))
        p_type = request.args.get('type', 'massive')
        steps = int(request.args.get('steps', 1500))
        dt = float(request.args.get('dt', 0.1))
        
        path = integrate_geodesic(m, r0, vr0, vt0, particle_type=p_type, step_size=dt, max_steps=steps)
        
        # Calculate theoretical values
        Rs = 2.0 * m
        R_photon = 3.0 * m
        R_isco = 6.0 * m
        
        return jsonify({
            "success": True,
            "Rs": Rs,
            "R_photon": R_photon,
            "R_isco": R_isco,
            "path": path
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 400

if __name__ == '__main__':
    # Default port is 5000
    app.run(host='0.0.0.0', port=5000, debug=True)
