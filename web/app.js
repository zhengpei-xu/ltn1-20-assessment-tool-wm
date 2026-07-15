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
  jat: { 0:'#d73027', 1:'#fee08b', 2:'#1a9850' },
  facility: {
    'Mixed Traffic':'#888','Advisory Cycle Lane':'#fee08b','Mandatory Cycle Lane':'#f4a460',
    'Light Segregation':'#90ee90','Stepped Cycle Track':'#66cdaa',
    'Fully Kerbed Cycle Track':'#2e8b57','Shared Use':'#4682b4',
  },
};

const FIELD_MAP = {
  overall:        { fwd:'clos_overall_pct_fwd', bwd:'clos_overall_pct_bwd' },
  safety:         { fwd:'clos_safety_pct_fwd',  bwd:'clos_safety_pct_bwd' },
  attractiveness: { fwd:'clos_attract_pct_fwd', bwd:'clos_attract_pct_bwd' },
  jat:            { fwd:'jat_score_fwd',        bwd:'jat_score_bwd' },
  facility:       { fwd:'facility_type_fwd',    bwd:'facility_type_bwd' },
};

let state = { colourBy:'overall', direction:'fwd', origin:null, destination:null, clickMode:'origin' };

// =============================================================================
// Map
// =============================================================================

const map = new maplibregl.Map({
  container:'map',
  style: {
    version:8,
    sources: {
      'osm-raster': {
        type:'raster',
        tiles:['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'],
        tileSize:256,
        attribution:'&copy; OpenStreetMap contributors &copy; CARTO',
      },
    },
    layers:[{ id:'osm-base',type:'raster',source:'osm-raster',
      paint:{'raster-saturation':-0.1,'raster-brightness-max':1.0},
    }],
    glyphs:'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  },
  center:[-1.90,52.48], zoom:11, maxZoom:18, minZoom:8,
});

map.addControl(new maplibregl.NavigationControl(),'top-left');
map.addControl(new maplibregl.ScaleControl({unit:'metric'}),'bottom-left');

// =============================================================================
// Load Layers
// =============================================================================

map.on('load', () => {
  map.addSource('network',{type:'vector',url:'pmtiles://data/network.pmtiles'});

  map.addLayer({
    id:'network-lines',type:'line',source:'network','source-layer':'network',
    paint:{
      'line-width':['interpolate',['linear'],['zoom'],10,1,14,2.5,17,5],
      'line-color':buildColourExpression(),
      'line-opacity':0.85,
    },
    layout:{'line-cap':'round','line-join':'round'},
  });

  map.addLayer({
    id:'network-highlight',type:'line',source:'network','source-layer':'network',
    paint:{
      'line-width':['interpolate',['linear'],['zoom'],10,3,14,5,17,8],
      'line-color':'#fff','line-opacity':0.6,
    },
    filter:['==','osid',''],
  });

  updateLegend();

  // Reference layers
  fetch('data/cycle_parking.geojson')
    .then(r=>r.json())
    .then(data=>{
      map.addSource('parking',{type:'geojson',data});
      map.addLayer({
        id:'parking-points',type:'circle',source:'parking',
        paint:{
          'circle-radius':['interpolate',['linear'],['zoom'],10,2,14,5,17,8],
          'circle-color':'#06b6d4','circle-stroke-color':'#fff',
          'circle-stroke-width':1,'circle-opacity':0.85,
        },
        layout:{visibility:'none'},
      });
    }).catch(()=>{});

  fetch('data/pois.geojson')
    .then(r=>r.json())
    .then(data=>{
      map.addSource('pois',{type:'geojson',data});
      map.addLayer({
        id:'poi-points',type:'circle',source:'pois',
        paint:{
          'circle-radius':['interpolate',['linear'],['zoom'],10,1,14,3,17,6],
          'circle-color':['match',['get','poi_category'],
            'Education','#8b5cf6','Healthcare','#ef4444','Food & Drink','#f97316',
            'Retail','#eab308','Transport','#3b82f6','Leisure & Sport','#22c55e',
            'Office & Workplace','#6b7280','Community & Public Services','#ec4899','#9ca3af'],
          'circle-stroke-color':'#fff','circle-stroke-width':0.5,'circle-opacity':0.7,
        },
        layout:{visibility:'none'},
        minzoom:13,
      });
    }).catch(()=>{});

  // Hover
  map.on('mousemove','network-lines',(e)=>{
    map.getCanvas().style.cursor='pointer';
    if(e.features.length>0)
      map.setFilter('network-highlight',['==','osid',e.features[0].properties.osid]);
  });
  map.on('mouseleave','network-lines',()=>{
    map.getCanvas().style.cursor='';
    map.setFilter('network-highlight',['==','osid','']);
  });

  // Click handling
  let clickedFeature = false;

  map.on('click','network-lines',(e)=>{
    clickedFeature = true;
    if(e.features.length===0) return;
    const props = e.features[0].properties;
    showLinkInfo(props);
    showPopup(e.lngLat,props);
  });

  map.on('click',(e)=>{
    setTimeout(()=>{
      if(clickedFeature){clickedFeature=false;return;}
      if(state.clickMode==='origin'){
        state.origin=e.lngLat;
        document.getElementById('origin-input').value=
          `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
        state.clickMode='destination';
        addMarker('origin',e.lngLat);
      } else {
        state.destination=e.lngLat;
        document.getElementById('dest-input').value=
          `${e.lngLat.lat.toFixed(5)}, ${e.lngLat.lng.toFixed(5)}`;
        state.clickMode='origin';
        addMarker('destination',e.lngLat);
      }
      updateAssessButton();
    },50);
  });
});

// =============================================================================
// Colour Expressions
// =============================================================================

function buildColourExpression(){
  const {colourBy,direction}=state;
  if(colourBy==='facility'){
    const field=FIELD_MAP.facility[direction];
    const entries=Object.entries(COLOURS.facility).flatMap(([k,v])=>[k,v]);
    return ['match',['get',field],...entries,'#555'];
  }
  if(colourBy==='jat'){
    const field=FIELD_MAP.jat[direction];
    return ['case',
      ['==',['get',field],null],'#555',
      ['==',['get',field],0],COLOURS.jat[0],
      ['==',['get',field],1],COLOURS.jat[1],
      ['==',['get',field],2],COLOURS.jat[2],'#555'];
  }
  const field=FIELD_MAP[colourBy][direction];
  return ['case',
    ['==',['get',field],null],COLOURS.score.na,
    ['interpolate',['linear'],['get',field],...COLOURS.score.stops.flat()]
  ];
}

function updateMapColours(){
  if(!map.getLayer('network-lines'))return;
  map.setPaintProperty('network-lines','line-color',buildColourExpression());
  updateLegend();
}

// =============================================================================
// Legend
// =============================================================================

function updateLegend(){
  const container=document.getElementById('legend');
  const {colourBy}=state;
  if(colourBy==='facility'){
    container.innerHTML=Object.entries(COLOURS.facility).map(([name,color])=>
      `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${name}</div>`
    ).join('');return;
  }
  if(colourBy==='jat'){
    const labels={0:'Score 0 (High stress)',1:'Score 1 (Moderate)',2:'Score 2 (Low stress)'};
    container.innerHTML=Object.entries(COLOURS.jat).map(([s,color])=>
      `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${labels[s]}</div>`
    ).join('');return;
  }
  container.innerHTML=COLOURS.score.stops.map(([val,color])=>
    `<div class="legend-item"><span class="legend-swatch" style="background:${color}"></span>${val}%</div>`
  ).join('')+
  `<div class="legend-item"><span class="legend-swatch" style="background:${COLOURS.score.na}"></span>No data</div>`;
}

// =============================================================================
// Link Inspector / Popup
// =============================================================================

function showLinkInfo(props){
  const section=document.getElementById('link-info');
  const table=document.getElementById('info-table');
  const rows=[
    ['Name',props.name1_text||'—'],
    ['Road Class',props.roadclassification||'—'],
    ['Description',props.description||'—'],
    ['Facility (fwd)',props.facility_type_fwd||'—'],
    ['Facility (bwd)',props.facility_type_bwd||'—'],
    ['Overall CLoS (fwd)',formatPct(props.clos_overall_pct_fwd)],
    ['Overall CLoS (bwd)',formatPct(props.clos_overall_pct_bwd)],
    ['Safety (fwd)',formatPct(props.clos_safety_pct_fwd)],
    ['Safety (bwd)',formatPct(props.clos_safety_pct_bwd)],
    ['Attract. (fwd)',formatPct(props.clos_attract_pct_fwd)],
    ['Attract. (bwd)',formatPct(props.clos_attract_pct_bwd)],
    ['JAT (fwd)',props.jat_score_fwd??'—'],
    ['JAT (bwd)',props.jat_score_bwd??'—'],
    ['Length',`${Number(props.geometry_length_m||0).toFixed(0)}m`],
  ];
  table.innerHTML=rows.map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  section.style.display='block';
}

function showPopup(lngLat,props){
  const d=state.direction;
  new maplibregl.Popup({closeButton:true,maxWidth:'260px'})
    .setLngLat(lngLat)
    .setHTML(`
      <strong>${props.name1_text||'Unnamed'}</strong><br/>
      <span style="color:#9aa0a9">${props.description||''}</span><br/>
      <span style="color:#9aa0a9">Facility:</span> ${props['facility_type_'+d]||'—'}<br/>
      <span style="color:#9aa0a9">CLoS:</span> ${formatPct(props['clos_overall_pct_'+d])}
    `)
    .addTo(map);
}

function formatPct(val){
  if(val===null||val===undefined||val==='')return '—';
  return `${Number(val).toFixed(1)}%`;
}

// =============================================================================
// Score Display
// =============================================================================

function updateScoreDisplay(scores){
  const el=document.getElementById('score-overall');
  const valEl=el.querySelector('.score-value');
  if(scores){
    valEl.textContent=`${scores.overall.toFixed(0)}%`;
    valEl.style.color=scoreColour(scores.overall);
    for(const dim of ['safety','attractiveness','comfort','directness','coherence']){
      const val=scores[dim];
      document.getElementById(`val-${dim}`).textContent=val!==null?`${val.toFixed(0)}%`:'—';
      const fill=document.getElementById(`fill-${dim}`);
      fill.style.width=val!==null?`${val}%`:'0%';
      fill.style.background=val!==null?scoreColour(val):'var(--text-muted)';
    }
  } else {
    valEl.textContent='—';
    valEl.style.color='var(--text-muted)';
    for(const dim of ['safety','attractiveness','comfort','directness','coherence']){
      document.getElementById(`val-${dim}`).textContent='—';
      const fill=document.getElementById(`fill-${dim}`);
      fill.style.width='0%';
      fill.style.background='var(--text-muted)';
    }
  }
}

function scoreColour(val){
  if(val>=85) return '#1a9850';
  if(val>=70) return '#a6d96a';
  if(val>=50) return '#fee08b';
  if(val>=25) return '#f46d43';
  return '#d73027';
}

// =============================================================================
// OD Markers
// =============================================================================

const markers={origin:null,destination:null};

function addMarker(type,lngLat){
  if(markers[type]) markers[type].remove();
  const el=document.createElement('div');
  el.style.cssText=`width:14px;height:14px;border-radius:50%;border:2px solid #fff;
    background:${type==='origin'?'#22c55e':'#ef4444'};box-shadow:0 2px 6px rgba(0,0,0,0.3);`;
  markers[type]=new maplibregl.Marker({element:el}).setLngLat(lngLat).addTo(map);
}

function updateAssessButton(){
  document.getElementById('btn-assess').disabled=!(state.origin&&state.destination);
}

// =============================================================================
// Routing Engine
// =============================================================================

let graph = null;

async function loadGraph(){
  try {
    const res = await fetch('data/graph.json.gz');
    const ds = new DecompressionStream('gzip');
    const reader = res.body.pipeThrough(ds).getReader();
    const chunks = [];
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      chunks.push(value);
    }
    const blob = new Blob(chunks);
    const text = await blob.text();
    const raw = JSON.parse(text);

    // Build adjacency list
    // Edge format: [from, to, length_dm, overall*10, safety*10, attract*10, gradient*100, a19*10, a3*10]
    const nNodes = raw.n.length / 2;
    const adj = new Map();
    for(const e of raw.e){
      const [from,to,len,overall,safety,attract,gradient,a19,a3] = e;
      if(!adj.has(from)) adj.set(from,[]);
      adj.get(from).push({to,len,overall,safety,attract,gradient,a19,a3});
    }

    graph = {nodes:raw.n, adj, nNodes};
    console.log(`Graph loaded: ${nNodes.toLocaleString()} nodes, ${raw.e.length.toLocaleString()} edges`);
  } catch(err){
    console.error('Failed to load graph:',err);
  }
}

function nearestNode(lng,lat){
  let best=-1, bestDist=Infinity;
  for(let i=0;i<graph.nNodes;i++){
    const dx=graph.nodes[i*2]-lng;
    const dy=graph.nodes[i*2+1]-lat;
    const d=dx*dx+dy*dy;
    if(d<bestDist){bestDist=d;best=i;}
  }
  return best;
}

function dijkstra(startNode,endNode){
  const dist=new Float64Array(graph.nNodes).fill(Infinity);
  const prev=new Int32Array(graph.nNodes).fill(-1);
  const visited=new Uint8Array(graph.nNodes);
  const edgeData=new Map();

  dist[startNode]=0;
  const heap=[[0,startNode]];

  while(heap.length>0){
    let minIdx=0;
    for(let i=1;i<heap.length;i++){
      if(heap[i][0]<heap[minIdx][0]) minIdx=i;
    }
    const [d,u]=heap[minIdx];
    heap[minIdx]=heap[heap.length-1];
    heap.pop();

    if(visited[u]) continue;
    visited[u]=1;
    if(u===endNode) break;

    const neighbors=graph.adj.get(u);
    if(!neighbors) continue;

    for(const edge of neighbors){
      if(visited[edge.to]) continue;

      // Stress-penalised weight
      const overallPct = edge.overall / 10; // back to 0-100
      const stressFactor = overallPct > 0
        ? 1 + 2 * (1 - overallPct / 100)
        : 3;
      const weight = (edge.len / 10) * stressFactor;

      const newDist = d + weight;
      if(newDist < dist[edge.to]){
        dist[edge.to]=newDist;
        prev[edge.to]=u;
        edgeData.set(edge.to,edge);
        heap.push([newDist,edge.to]);
      }
    }
  }

  if(dist[endNode]===Infinity) return null;

  const path=[];
  const pathEdges=[];
  let cur=endNode;
  while(cur!==-1){
    path.push(cur);
    if(edgeData.has(cur)) pathEdges.push(edgeData.get(cur));
    cur=prev[cur];
  }
  path.reverse();
  pathEdges.reverse();

  return {path,edges:pathEdges,totalDist:dist[endNode]};
}

// =============================================================================
// Route Scoring
// =============================================================================

function computeRouteScores(pathEdges, startNode, endNode) {
  if (pathEdges.length === 0) return null;

  let totalLen = 0;
  let sumSafety = 0, sumAttract = 0;
  let comfortLen = 0, sumComfort = 0;
  let sumCoherence = 0;

  for (const e of pathEdges) {
    const len = e.len / 10; // metres
    totalLen += len;

    sumSafety += (e.safety / 10) * len;     // 0-100 pct
    sumAttract += (e.attract / 10) * len;   // 0-100 pct
    sumCoherence += (e.a3 / 10) * len;      // 0-2 raw

    if (e.a19 >= 0) {
      comfortLen += len;
      sumComfort += (e.a19 / 10) * len;     // 0-2 raw
    }
  }

  if (totalLen === 0) return null;

  // --- Dimension percentages (0-100) ---

  const safety = sumSafety / totalLen;
  const attractiveness = sumAttract / totalLen;
  const coherenceRaw = sumCoherence / totalLen;           // 0-2
  const coherence = (coherenceRaw / 2) * 100;             // 0-100
  const comfortRaw = comfortLen > 0 ? sumComfort / comfortLen : null; // 0-2
  const comfort = comfortRaw !== null ? (comfortRaw / 2) * 100 : null; // 0-100

  // Directness: detour ratio (D7) + gradient (D8)
  const startLng = graph.nodes[startNode * 2], startLat = graph.nodes[startNode * 2 + 1];
  const endLng = graph.nodes[endNode * 2], endLat = graph.nodes[endNode * 2 + 1];
  const straightLine = haversine(startLat, startLng, endLat, endLng);
  const detourRatio = straightLine > 0 ? straightLine / totalLen : 0;
  const detourScore = detourRatio > 0.8 ? 2 : (detourRatio > 0.6 ? 1 : 0);
  const gradResult = scoreRouteGradient(pathEdges);
  const directness = ((detourScore + gradResult.score) / 4) * 100; // 0-100

  // --- Overall CLoS: LTN 1/20 original weights ---
  // Safety 8/25, Directness 5/25, Comfort 4/25, Attractiveness 5/25, Coherence 3/25

  let overall;
  if (comfort !== null) {
    overall = safety          * (8 / 25) +
              directness      * (5 / 25) +
              comfort         * (4 / 25) +
              attractiveness  * (5 / 25) +
              coherence       * (3 / 25);
  } else {
    // No cycle provision on route — redistribute comfort weight proportionally
    const w = 8 + 5 + 5 + 3; // = 21
    overall = safety          * (8 / w) +
              directness      * (5 / w) +
              attractiveness  * (5 / w) +
              coherence       * (3 / w);
  }

  return {
    overall, safety, attractiveness,
    comfort, directness, coherence,
    totalLength: totalLen, straightLine,
    detourRatio, gradientResult: gradResult,
  };
}

function scoreRouteGradient(pathEdges){
  // Table 5-8: gradient% → max continuous length (m)
  const table58 = [
    [5.0,30],[4.5,40],[4.0,50],[3.5,60],[3.0,80],[2.5,100],[2.0,150]
  ];

  let maxGradient = 0;
  let exceedsTable = false;

  // Scan continuous uphill sections
  // Group consecutive edges with gradient >= 2% into sections
  let currentLen = 0;
  let currentMaxGrad = 0;
  let inUphill = false;

  for(const e of pathEdges){
    const grad = e.gradient / 100; // back to %
    const len = e.len / 10; // metres

    if(grad > maxGradient) maxGradient = grad;

    if(grad >= 2.0){
      // Continuing or starting uphill section
      currentLen += len;
      if(grad > currentMaxGrad) currentMaxGrad = grad;
      inUphill = true;
    } else {
      // End of uphill section — check against table
      if(inUphill){
        exceedsTable = exceedsTable || checkTable58(table58, currentMaxGrad, currentLen);
        currentLen = 0;
        currentMaxGrad = 0;
        inUphill = false;
      }
    }
  }
  // Check last section
  if(inUphill){
    exceedsTable = exceedsTable || checkTable58(table58, currentMaxGrad, currentLen);
  }

  if(maxGradient < 2.0) return {score:2, label:'No sections steeper than 2%', maxGradient};
  if(!exceedsTable) return {score:1, label:'Within Table 5-8 limits', maxGradient};
  return {score:0, label:'Exceeds Table 5-8 limits', maxGradient};
}

function checkTable58(table,grad,len){
  for(const [threshold,maxLen] of table){
    if(grad >= threshold && len > maxLen) return true;
  }
  return false;
}

function haversine(lat1,lon1,lat2,lon2){
  const R=6371000;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+
    Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*
    Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// =============================================================================
// Assess Route
// =============================================================================

function assessRoute(){
  if(!graph||!state.origin||!state.destination) return;

  const startNode=nearestNode(state.origin.lng,state.origin.lat);
  const endNode=nearestNode(state.destination.lng,state.destination.lat);

  if(startNode===endNode){
    alert('Origin and destination snap to the same node. Try points further apart.');
    return;
  }

  const t0=performance.now();
  const result=dijkstra(startNode,endNode);
  const t1=performance.now();
  console.log(`Dijkstra: ${(t1-t0).toFixed(0)}ms`);

  if(!result){
    alert('No route found between these points.');
    return;
  }

  // Draw route
  const coords=result.path.map(n=>[graph.nodes[n*2],graph.nodes[n*2+1]]);
  const geojson={type:'Feature',geometry:{type:'LineString',coordinates:coords}};

  if(map.getLayer('route-line')) map.removeLayer('route-line');
  if(map.getLayer('route-outline')) map.removeLayer('route-outline');
  if(map.getSource('route')) map.removeSource('route');

  map.addSource('route',{type:'geojson',data:geojson});

  map.addLayer({
    id:'route-outline',type:'line',source:'route',
    paint:{'line-color':'#1e293b','line-width':8,'line-opacity':0.6},
    layout:{'line-cap':'round','line-join':'round'},
  });
  map.addLayer({
    id:'route-line',type:'line',source:'route',
    paint:{'line-color':'#3b82f6','line-width':5,'line-opacity':0.9},
    layout:{'line-cap':'round','line-join':'round'},
  });

  // Score
  const scores=computeRouteScores(result.edges,startNode,endNode);

  if(scores){
    updateScoreDisplay(scores);

    // Route info panel
    const section=document.getElementById('link-info');
    const table=document.getElementById('info-table');
    table.innerHTML=[
      ['Route length',`${(scores.totalLength/1000).toFixed(1)} km`],
      ['Straight line',`${(scores.straightLine/1000).toFixed(1)} km`],
      ['Detour ratio',`${(scores.totalLength/scores.straightLine).toFixed(2)}`],
      ['Links in route',`${result.edges.length}`],
      ['Max gradient',`${scores.gradientResult.maxGradient.toFixed(1)}%`],
      ['Gradient',scores.gradientResult.label],
      ['Routing time',`${(t1-t0).toFixed(0)}ms`],
    ].map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    section.style.display='block';
  }

  // Fit bounds
  const bounds=coords.reduce((b,c)=>b.extend(c),
    new maplibregl.LngLatBounds(coords[0],coords[0]));
  map.fitBounds(bounds,{padding:80});
}

// Load graph on startup
loadGraph();

// =============================================================================
// Event Listeners
// =============================================================================

document.getElementById('colour-by').addEventListener('change',(e)=>{
  state.colourBy=e.target.value;
  updateMapColours();
});

document.querySelectorAll('.toggle-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.toggle-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.direction=btn.dataset.dir;
    updateMapColours();
  });
});

document.getElementById('btn-reset').addEventListener('click',()=>{
  state.origin=null;state.destination=null;state.clickMode='origin';
  document.getElementById('origin-input').value='';
  document.getElementById('dest-input').value='';
  if(markers.origin)markers.origin.remove();
  if(markers.destination)markers.destination.remove();
  updateAssessButton();
  updateScoreDisplay(null);
  if(map.getLayer('route-line'))map.removeLayer('route-line');
  if(map.getLayer('route-outline'))map.removeLayer('route-outline');
  if(map.getSource('route'))map.removeSource('route');
  document.getElementById('link-info').style.display='none';
});

document.getElementById('clear-origin').addEventListener('click',()=>{
  state.origin=null;
  document.getElementById('origin-input').value='';
  if(markers.origin)markers.origin.remove();
  state.clickMode='origin';
  updateAssessButton();
});

document.getElementById('clear-dest').addEventListener('click',()=>{
  state.destination=null;
  document.getElementById('dest-input').value='';
  if(markers.destination)markers.destination.remove();
  state.clickMode='destination';
  updateAssessButton();
});

document.getElementById('btn-assess').addEventListener('click',()=>{
  if(!state.origin||!state.destination) return;
  if(!graph){alert('Graph still loading, please wait...');return;}
  assessRoute();
});

document.getElementById('layer-parking').addEventListener('change',(e)=>{
  if(map.getLayer('parking-points'))
    map.setLayoutProperty('parking-points','visibility',e.target.checked?'visible':'none');
});

document.getElementById('layer-pois').addEventListener('change',(e)=>{
  if(map.getLayer('poi-points'))
    map.setLayoutProperty('poi-points','visibility',e.target.checked?'visible':'none');
});

updateScoreDisplay(null);