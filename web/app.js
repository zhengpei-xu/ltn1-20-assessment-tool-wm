// =============================================================================
// LTN 1/20 Assessment Tool — Main Application
// =============================================================================

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const COLOURS = {
  score: {
    stops: [[0,'#d73027'],[25,'#f46d43'],[50,'#fee08b'],[70,'#a6d96a'],[85,'#1a9850']],
    na: '#555'
  },
  jat: { 0: '#d73027', 1: '#fee08b', 2: '#1a9850' },
  facility: {
    'Mixed Traffic':'#888','Advisory Cycle Lane':'#fee08b','Mandatory Cycle Lane':'#f4a460',
    'Light Segregation':'#90ee90','Stepped Cycle Track':'#66cdaa',
    'Fully Kerbed Cycle Track':'#2e8b57','Shared Use':'#4682b4',
  },
};

const FIELD_MAP = {
  overall:        { fwd: 'clos_overall_pct_fwd', bwd: 'clos_overall_pct_bwd' },
  safety:         { fwd: 'clos_safety_pct_fwd',  bwd: 'clos_safety_pct_bwd' },
  attractiveness: { fwd: 'clos_attract_pct_fwd', bwd: 'clos_attract_pct_bwd' },
  jat:            { fwd: 'jat_score_fwd',        bwd: 'jat_score_bwd' },
  facility:       { fwd: 'facility_type_fwd',    bwd: 'facility_type_bwd' },
};

let state = { colourBy:'overall', direction:'fwd', origin:null, destination:null, clickMode:'origin' };

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      'osm-raster': {
        type:'raster',
        tiles:['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'],
        tileSize:256,
        attribution:'&copy; OpenStreetMap contributors &copy; CARTO',
      },
    },
    layers: [{ id:'osm-base', type:'raster', source:'osm-raster',
      paint:{ 'raster-saturation':-0.1, 'raster-brightness-max':1.0 },
    }],
    glyphs:'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  },
  center: [-1.90, 52.48], zoom:11, maxZoom:18, minZoom:8,
});

map.addControl(new maplibregl.NavigationControl(), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit:'metric' }), 'bottom-left');

// =============================================================================
// Load Network
// =============================================================================

map.on('load', () => {
  map.addSource('network', { type:'vector', url:'pmtiles://data/network.pmtiles' });

  map.addLayer({
    id:'network-lines', type:'line', source:'network', 'source-layer':'network',
    paint: {
      'line-width':['interpolate',['linear'],['zoom'],10,1,14,2.5,17,5],
      'line-color': buildColourExpression(),
      'line-opacity': 0.85,
    },
    layout: { 'line-cap':'round', 'line-join':'round' },
  });

  map.addLayer({
    id:'network-highlight', type:'line', source:'network', 'source-layer':'network',
    paint: {
      'line-width':['interpolate',['linear'],['zoom'],10,3,14,5,17,8],
      'line-color':'#fff', 'line-opacity':0.6,
    },
    filter: ['==','osid',''],
  });

  updateLegend();

  // Hover
  map.on('mousemove','network-lines',(e) => {
    map.getCanvas().style.cursor = 'pointer';
    if (e.features.length > 0)
      map.setFilter('network-highlight',['==','osid',e.features[0].properties.osid]);
  });
  map.on('mouseleave','network-lines',() => {
    map.getCanvas().style.cursor = '';
    map.setFilter('network-highlight',['==','osid','']);
  });

  // --- Unified click: feature click vs OD placement ---
  let clickedFeature = false;

  map.on('click','network-lines',(e) => {
    clickedFeature = true;
    if (e.features.length === 0) return;
    const props = e.features[0].properties;
    showLinkInfo(props);
    showPopup(e.lngLat, props);
  });

  map.on('click',(e) => {
    setTimeout(() => {
      if (clickedFeature) { clickedFeature = false; return; }

      if (state.clickMode === 'origin') {
        state.origin = e.lngLat;
        document.getElementById('origin-input').value =
          `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
        state.clickMode = 'destination';
        addMarker('origin', e.lngLat);
      } else {
        state.destination = e.lngLat;
        document.getElementById('dest-input').value =
          `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
        state.clickMode = 'origin';
        addMarker('destination', e.lngLat);
      }
      updateAssessButton();
    }, 50);
  });
});

// =============================================================================
// Colour Expressions
// =============================================================================

function buildColourExpression() {
  const { colourBy, direction } = state;
  if (colourBy === 'facility') {
    const field = FIELD_MAP.facility[direction];
    const entries = Object.entries(COLOURS.facility).flatMap(([k,v])=>[k,v]);
    return ['match',['get',field],...entries,'#555'];
  }
  if (colourBy === 'jat') {
    const field = FIELD_MAP.jat[direction];
    return ['case',
      ['==',['get',field],null],'#555',
      ['==',['get',field],0],COLOURS.jat[0],
      ['==',['get',field],1],COLOURS.jat[1],
      ['==',['get',field],2],COLOURS.jat[2],
      '#555'];
  }
  const field = FIELD_MAP[colourBy][direction];
  return ['case',
    ['==',['get',field],null],COLOURS.score.na,
    ['interpolate',['linear'],['get',field],...COLOURS.score.stops.flat()]
  ];
}

function updateMapColours() {
  if (!map.getLayer('network-lines')) return;
  map.setPaintProperty('network-lines','line-color',buildColourExpression());
  updateLegend();
}

// =============================================================================
// Legend
// =============================================================================

function updateLegend() {
  const container = document.getElementById('legend');
  const { colourBy } = state;
  if (colourBy === 'facility') {
    container.innerHTML = Object.entries(COLOURS.facility).map(([name,color]) =>
      `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${name}</div>`
    ).join('');
    return;
  }
  if (colourBy === 'jat') {
    const labels = {0:'Score 0 (High stress)',1:'Score 1 (Moderate)',2:'Score 2 (Low stress)'};
    container.innerHTML = Object.entries(COLOURS.jat).map(([s,color]) =>
      `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${labels[s]}</div>`
    ).join('');
    return;
  }
  container.innerHTML = COLOURS.score.stops.map(([val,color]) =>
    `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${val}%</div>`
  ).join('') +
  `<div class="legend-item"><span class="legend-swatch" style="background:${COLOURS.score.na}"></span>No data</div>`;
}

// =============================================================================
// Link Inspector / Popup
// =============================================================================

function showLinkInfo(props) {
  const section = document.getElementById('link-info');
  const table = document.getElementById('info-table');
  const rows = [
    ['Name', props.name1_text || '—'],
    ['Road Class', props.roadclassification || '—'],
    ['Description', props.description || '—'],
    ['Facility (fwd)', props.facility_type_fwd || '—'],
    ['Facility (bwd)', props.facility_type_bwd || '—'],
    ['Overall CLoS (fwd)', formatPct(props.clos_overall_pct_fwd)],
    ['Overall CLoS (bwd)', formatPct(props.clos_overall_pct_bwd)],
    ['Safety (fwd)', formatPct(props.clos_safety_pct_fwd)],
    ['Safety (bwd)', formatPct(props.clos_safety_pct_bwd)],
    ['Attract. (fwd)', formatPct(props.clos_attract_pct_fwd)],
    ['Attract. (bwd)', formatPct(props.clos_attract_pct_bwd)],
    ['JAT (fwd)', props.jat_score_fwd ?? '—'],
    ['JAT (bwd)', props.jat_score_bwd ?? '—'],
    ['Length', `${Number(props.geometry_length_m || 0).toFixed(0)}m`],
  ];
  table.innerHTML = rows.map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  section.style.display = 'block';
}

function showPopup(lngLat, props) {
  const d = state.direction;
  new maplibregl.Popup({ closeButton:true, maxWidth:'260px' })
    .setLngLat(lngLat)
    .setHTML(`
      <strong>${props.name1_text || 'Unnamed'}</strong><br/>
      <span style="color:#9aa0a9">${props.description || ''}</span><br/>
      <span style="color:#9aa0a9">Facility:</span> ${props['facility_type_'+d] || '—'}<br/>
      <span style="color:#9aa0a9">CLoS:</span> ${formatPct(props['clos_overall_pct_'+d])}
    `)
    .addTo(map);
}

function formatPct(val) {
  if (val === null || val === undefined || val === '') return '—';
  return `${Number(val).toFixed(1)}%`;
}

// =============================================================================
// Score Display
// =============================================================================

function updateScoreDisplay(scores) {
  const el = document.getElementById('score-overall');
  const valEl = el.querySelector('.score-value');
  if (scores) {
    valEl.textContent = `${scores.overall.toFixed(0)}%`;
    valEl.style.color = scoreColour(scores.overall);
    for (const dim of ['safety','attractiveness','comfort','directness','coherence']) {
      const val = scores[dim];
      document.getElementById(`val-${dim}`).textContent = val !== null ? `${val.toFixed(0)}%` : '—';
      const fill = document.getElementById(`fill-${dim}`);
      fill.style.width = val !== null ? `${val}%` : '0%';
      fill.style.background = val !== null ? scoreColour(val) : 'var(--text-muted)';
    }
  } else {
    valEl.textContent = '—';
    valEl.style.color = 'var(--text-muted)';
    for (const dim of ['safety','attractiveness','comfort','directness','coherence']) {
      document.getElementById(`val-${dim}`).textContent = '—';
      const fill = document.getElementById(`fill-${dim}`);
      fill.style.width = '0%';
      fill.style.background = 'var(--text-muted)';
    }
  }
}

function scoreColour(val) {
  if (val >= 85) return '#1a9850';
  if (val >= 70) return '#a6d96a';
  if (val >= 50) return '#fee08b';
  if (val >= 25) return '#f46d43';
  return '#d73027';
}

// =============================================================================
// OD Markers
// =============================================================================

const markers = { origin:null, destination:null };

function addMarker(type, lngLat) {
  if (markers[type]) markers[type].remove();
  const el = document.createElement('div');
  el.style.cssText = `width:14px;height:14px;border-radius:50%;border:2px solid #fff;
    background:${type==='origin'?'#22c55e':'#ef4444'};box-shadow:0 2px 6px rgba(0,0,0,0.3);`;
  markers[type] = new maplibregl.Marker({ element:el }).setLngLat(lngLat).addTo(map);
}

function updateAssessButton() {
  document.getElementById('btn-assess').disabled = !(state.origin && state.destination);
}

// =============================================================================
// Event Listeners
// =============================================================================

document.getElementById('colour-by').addEventListener('change',(e) => {
  state.colourBy = e.target.value;
  updateMapColours();
});

document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click',() => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.direction = btn.dataset.dir;
    updateMapColours();
  });
});

document.getElementById('btn-reset').addEventListener('click',() => {
  state.origin = null; state.destination = null; state.clickMode = 'origin';
  document.getElementById('origin-input').value = '';
  document.getElementById('dest-input').value = '';
  if (markers.origin) markers.origin.remove();
  if (markers.destination) markers.destination.remove();
  updateAssessButton();
  updateScoreDisplay(null);
  if (map.getLayer('route-line')) map.removeLayer('route-line');
  if (map.getSource('route')) map.removeSource('route');
});

document.getElementById('clear-origin').addEventListener('click',() => {
  state.origin = null;
  document.getElementById('origin-input').value = '';
  if (markers.origin) markers.origin.remove();
  state.clickMode = 'origin';
  updateAssessButton();
});

document.getElementById('clear-dest').addEventListener('click',() => {
  state.destination = null;
  document.getElementById('dest-input').value = '';
  if (markers.destination) markers.destination.remove();
  state.clickMode = 'destination';
  updateAssessButton();
});

document.getElementById('btn-assess').addEventListener('click',() => {
  if (!state.origin || !state.destination) return;
  alert('Route assessment will use client-side Dijkstra routing on the directed network.\n\nThis feature is under development.\n\nMeanwhile, click individual links to inspect their CLoS scores.');
});

updateScoreDisplay(null);