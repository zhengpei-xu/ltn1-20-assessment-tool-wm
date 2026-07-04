# %% [markdown]
# # CLoS & JAT Scoring Pipeline
#
# Computes link-level Cycling Level of Service (CLoS) and Junction Assessment
# Tool (JAT) scores for the West Midlands metropolitan county cycling network,
# following LTN 1/20 Appendix A criteria.
#
# ## Notebook Structure
#
# | Section | Content |
# |---------|---------|
# | 0 | Setup and constants |
# | 1 | Study area boundary |
# | 2 | Data loading (OS NGD Road Links, Cycle Lanes, Highway Dedication) |
# | 3 | Network preparation (cycleable links, facility classification) |
# | 4 | Speed and AADT data |
# | 5 | **Safety criteria** (S10 Speed, S11 Volume, S12 Segregation, S15 Kerbside) |
# | 6 | Safety aggregate |
# | 7 | **Attractiveness criteria** (A3 Density, A19 Width, A21 Lighting, A22 Isolation, A25 Parking) |
# | 8 | Attractiveness aggregate |
# | 9 | **JAT** (Junction Assessment Tool) |
# | 10 | **Overall CLoS aggregate** |
# | 11 | Visualisation |
# | 12 | Export (network GeoPackage, POI GeoJSON, cycle parking GeoJSON) |

# %% [markdown]
# ---
# ## 0. Setup

# %%
import warnings
warnings.filterwarnings('ignore')

import os
import io
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
import matplotlib.pyplot as plt
import osmnx as ox
from shapely import wkt
from shapely.ops import unary_union
from scipy.spatial import cKDTree

ox.settings.timeout = 600

# Project paths
DATA_DIR = Path('../Data/Raw')
OUTPUT_DIR = Path('../Data/Cleaned')
DATA_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# Coordinate reference systems
CRS_WGS84 = 'EPSG:4326'
CRS_BNG = 'EPSG:27700'

pd.set_option('display.max_columns', None)
print(f"Working directory: {os.getcwd()}")

# %% [markdown]
# ---
# ## 1. Study Area Boundary

# %%
STUDY_AREA_BOROUGHS = [
    'Birmingham',
    'Coventry',
    'Dudley',
    'Sandwell',
    'Solihull',
    'Walsall',
    'Wolverhampton',
]

raw_data = gpd.read_file(
    DATA_DIR / "Local_Authority_Districts_DEC_2025_Boundaries_UK_BFC_7781342770234899863/LAD_DEC_2025_UK_BFC.shp"
)
study_area = raw_data[raw_data['LAD25NM'].isin(STUDY_AREA_BOROUGHS)].copy()
study_area = study_area.to_crs(CRS_BNG)

fig, ax = plt.subplots(figsize=(10, 10))
study_area.plot(ax=ax, edgecolor='black', facecolor='lightblue', alpha=0.6)
study_area.apply(lambda r: ax.annotate(
    text=r['LAD25NM'],
    xy=(r.geometry.centroid.x, r.geometry.centroid.y),
    ha='center', fontsize=9
), axis=1)
ax.set_title(f'Study area: {len(STUDY_AREA_BOROUGHS)} WMCA boroughs')
ax.set_axis_off()
plt.tight_layout()
plt.show()

total_area_km2 = study_area.geometry.area.sum() / 1e6
print(f"\nTotal study area: {total_area_km2:.1f} km2")

# %% [markdown]
# ---
# ## 2. Data Loading

# %%
# --- 2a. OS NGD Road Links ---
os_road_network = gpd.read_file(DATA_DIR / "os_datasets/trn_ntwk_roadlink.zip")
os_road_network["geometry"] = os_road_network["geometry"].apply(wkt.loads)
os_road_network = gpd.GeoDataFrame(os_road_network, geometry="geometry", crs=CRS_BNG)

print(f"Road links: {os_road_network.shape[0]:,} features, {os_road_network.shape[1]} columns")
print(f"\nRoad type distribution:")
print(os_road_network['roadclassification'].value_counts())

# %%
# --- 2b. OS NGD Cycle Lanes ---
os_cycle_lane = gpd.read_file(DATA_DIR / "os_datasets/trn_ntwk_cyclelane.zip")
os_cycle_lane["geometry"] = os_cycle_lane["geometry"].apply(wkt.loads)
os_cycle_lane = gpd.GeoDataFrame(os_cycle_lane, geometry="geometry", crs=CRS_BNG)

print(f"Cycle lanes: {os_cycle_lane.shape[0]:,} features")
print(f"\nCycle lane type distribution:")
print(os_cycle_lane['description'].value_counts())

# %%
# --- 2c. Highway Dedication ---
zip_path = DATA_DIR / "os_datasets/trn_rami_highwaydedication.zip"
with zipfile.ZipFile(zip_path) as z:
    hd = pd.read_csv(io.BytesIO(z.read("trn_rami_highwaydedication.csv")))
    hd_ref = pd.read_csv(io.BytesIO(z.read("trn_rami_highwaydedication_hwydedntwkref.csv")))

print(f"Highway Dedication records: {hd.shape[0]:,}")
print(f"Network references: {hd_ref.shape[0]:,} ({hd_ref['networkreferenceid'].nunique():,} unique links)")

# %% [markdown]
# ---
# ## 3. Network Preparation

# %%
# --- 3a. Join Highway Dedication to Road Links ---
hd_merged = hd_ref.merge(
    hd[['osid', 'description']],
    left_on='highwaydedicationid',
    right_on='osid',
    how='left'
)
hd_lookup = (
    hd_merged[['networkreferenceid', 'description']]
    .drop_duplicates(subset='networkreferenceid')
    .rename(columns={'networkreferenceid': 'osid', 'description': 'highway_dedication'})
)
os_road_network = os_road_network.merge(hd_lookup, on='osid', how='left')

# %%
# --- 3b. Filter to Cycleable Road Links ---
cycleable_dedications = [
    'All Vehicles',
    'Cycle Track Or Cycle Way',
    'Bridleway',
    'Restricted Byway',
    'Byway Open To All Traffic',
]
non_cycleable_descriptions = [
    'Motorway', 'A Road Primary',
]

cycleable_mask = (
    os_road_network['highway_dedication'].isin(cycleable_dedications) &
    ~os_road_network['roadclassification'].isin(non_cycleable_descriptions)
)
cycleable_roads = os_road_network[cycleable_mask].copy()
print(f"Cycleable road links: {len(cycleable_roads):,} / {len(os_road_network):,}")

# %%
# --- 3c. Join Cycle Lane ---
cycleable_roads_with_cl = cycleable_roads.merge(
    os_cycle_lane[['linkid', 'description', 'cyclelaneinfo_modalwidth_m',
                    'cyclelaneinfo_minimumwidth_m', 'cyclelaneinfo_direction',
                    'sideoflink']].rename(columns={'linkid': 'osid', 'description': 'cyclelane_type'}),
    on='osid',
    how='left'
)

# %%
# --- 3d. Facility Classification (8 Categories) ---
os_to_facility = {
    'Fully Segregated Cycle Track':           'Fully Kerbed Cycle Track',
    'Unsegregated Shared-Use Cycle Facility': 'Shared Use',
    'Segregated Shared-Use Cycle Track':      'Shared Use',
    'Advisory Cycle Lane On Road':            'Advisory Cycle Lane',
    'Mandatory Cycle Lane On Road':           'Mandatory Cycle Lane',
    'Lightly Segregated Cycle Lane On Road':  'Light Segregation',
    'Stepped Cycle Track Along Road':         'Stepped Cycle Track',
    'Unknown Type Of Cycle Track Or Lane':    'Mixed Traffic',
}
cycleable_roads_with_cl['facility_type'] = (
    cycleable_roads_with_cl['cyclelane_type']
    .map(os_to_facility)
    .fillna('Mixed Traffic')
)
print(f"\nFacility type distribution:")
print(cycleable_roads_with_cl['facility_type'].value_counts())

# %% [markdown]
# ---
# ## 4. Speed and AADT Data

# %%
existing_cols = set(cycleable_roads_with_cl.columns)

# --- Speed data ---
speed_data = gpd.read_file(
    DATA_DIR / "os_datasets_1/os_data/trn_rami_averageandindicativespeed.gpkg"
)
avg_speed_cols = [c for c in speed_data.columns
                  if c.startswith('averagespeed_') or c.startswith('indicativespeed_')]
speed_wide = speed_data.pivot_table(
    index='networkreferenceid', columns='timeperiod',
    values=avg_speed_cols, aggfunc='first'
)
speed_wide.columns = ['_'.join(col).strip() for col in speed_wide.columns]
speed_wide = speed_wide.reset_index().rename(columns={'networkreferenceid': 'osid'})

cycleable_roads_with_cl = cycleable_roads_with_cl.merge(speed_wide, on='osid', how='left')
new_speed_cols = set(cycleable_roads_with_cl.columns) - existing_cols
print(f"Speed columns added: {len(new_speed_cols)}")

# --- Compute V85 (DMRB CA185 method) ---
# Mean of time-period averages x 7/6
avg_cols = [c for c in cycleable_roads_with_cl.columns if 'averagespeed_' in c]
cycleable_roads_with_cl['mean_avg_speed_kph'] = cycleable_roads_with_cl[avg_cols].mean(axis=1)
cycleable_roads_with_cl['est_v85_kph'] = cycleable_roads_with_cl['mean_avg_speed_kph'] * (7/6)
cycleable_roads_with_cl['est_v85_mph'] = cycleable_roads_with_cl['est_v85_kph'] * 0.621371

# --- AADT data ---
aadt_data = gpd.read_file(OUTPUT_DIR / "link_aadt_estimated.gpkg")
cycleable_roads_with_cl = cycleable_roads_with_cl.merge(
    aadt_data[['osid', 'aadt']], on='osid', how='left'
)
print(f"AADT coverage: {cycleable_roads_with_cl['aadt'].notna().sum():,} / {len(cycleable_roads_with_cl):,}")

# %% [markdown]
# ---
# ## 5. Safety Criteria (S10, S11, S12, S15)

# %% [markdown]
# ### S10: Motor Traffic Speed on Shared Carriageway
#
# | Score | Condition |
# |---|---|
# | 0 (Critical) | V85 > 37 mph |
# | 0 (Red) | V85 > 30 mph |
# | 1 (Amber) | V85 20-30 mph |
# | 2 (Green) | V85 < 20 mph, or off-carriageway facility |

# %%
# [INSERT score_clos_s10 function and apply here]

# %% [markdown]
# ### S11: Motor Traffic Volume on Shared Carriageway
#
# | Score | Condition |
# |---|---|
# | 0 (Critical) | AADT > 10,000 |
# | 0 (Red) | AADT 5,000-10,000 |
# | 1 (Amber) | AADT 2,500-5,000 |
# | 2 (Green) | AADT < 2,500, or off-carriageway facility |

# %%
# [INSERT score_clos_s11 function and apply here]

# %% [markdown]
# ### S12: Segregation to Reduce Risk of Collision
#
# Operationalises LTN 1/20 Figure 4.1 speed-flow-facility adequacy matrix.

# %%
# [INSERT score_clos_s12 function and apply here]

# %% [markdown]
# ### S15: Conflict with Kerbside Activity
#
# Uses cycle lane width as proxy for kerbside conflict risk.

# %%
# [INSERT score_clos_s15 function and apply here]

# %% [markdown]
# ---
# ## 6. Safety Aggregate

# %%
# [INSERT aggregate_clos_safety function and apply here]

# %% [markdown]
# ---
# ## 7. Attractiveness Criteria (A3, A19, A21, A22, A25)

# %% [markdown]
# ### A3: Density of Network
#
# Proxy: distance from each link to nearest protected cycling facility.
#
# | Score | Condition |
# |---|---|
# | 0 | Nearest protected facility > 500m |
# | 1 | 100-500m |
# | 2 | < 100m |

# %%
# [INSERT score_clos_a3_density function and apply here]

# %% [markdown]
# ### A19: Desirable Minimum Widths (LTN 1/20 Table 5-2)
#
# | Facility | Desirable Min (m) | Absolute Min (m) | Score 0 | Score 1 | Score 2 |
# |---|---|---|---|---|---|
# | 1-way protected space | 2.0 | 1.5 | < 1.5 | 1.5-2.0 | >= 2.0 |
# | 2-way protected space | 3.0 | 2.0 | < 2.0 | 2.0-3.0 | >= 3.0 |
# | 1-way cycle lane | 2.0 | 1.5 | < 1.5 | 1.5-2.0 | >= 2.0 |
# | Mixed traffic | N/A | N/A | not scored | not scored | not scored |

# %%
# [INSERT score_clos_a19_width function and apply here]

# %% [markdown]
# ### A21: Lighting
#
# | Score | OS NGD Category |
# |---|---|
# | 0 | Fully Unlit, Mostly Unlit |
# | 1 | Mostly Lit |
# | 2 | Fully Lit |
# | NaN | Unknown |

# %%
# [INSERT score_clos_a21_lighting function and apply here]

# %% [markdown]
# ### A22: Isolation (POI Density Proxy)
#
# Tercile-based classification of POI density (per 100m) within 50m buffer.

# %%
# --- Extract OSM POIs (batched by borough and tag) ---
# [INSERT extract_osm_pois, compute_poi_density, score_clos_a22_isolation here]

# %% [markdown]
# ### A25: Cycle Parking
#
# | Score | Condition |
# |---|---|
# | 0 | No parking within 500m |
# | 1 | Nearest parking 200-500m |
# | 2 | Nearest parking < 200m |

# %%
# --- Extract OSM Cycle Parking ---
# [INSERT extract_osm_cycle_parking, compute_cycle_parking_proximity, score_clos_a25_parking here]

# %% [markdown]
# ---
# ## 8. Attractiveness Aggregate

# %%
def aggregate_clos_attractiveness(df):
    score_cols = ['clos_a3', 'clos_a19', 'clos_a21', 'clos_a22', 'clos_a25']
    
    df['clos_attract_n_scored'] = df[score_cols].notna().sum(axis=1)
    df['clos_attract_sum'] = df[score_cols].sum(axis=1, skipna=True)
    df['clos_attract_max'] = df['clos_attract_n_scored'] * 2
    df['clos_attract_pct'] = np.where(
        df['clos_attract_max'] > 0,
        (df['clos_attract_sum'] / df['clos_attract_max']) * 100,
        np.nan
    )
    
    scored = df['clos_attract_pct'].notna()
    pct = df.loc[scored, 'clos_attract_pct']
    print("=" * 60)
    print("CLoS ATTRACTIVENESS SUMMARY")
    print("=" * 60)
    print(f"  Links scored:     {scored.sum():,} / {len(df):,}")
    print(f"  Mean attract %:   {pct.mean():.1f}%")
    print(f"  Median attract %: {pct.median():.1f}%")
    print(f"\n  Per-criterion averages (0-2 scale):")
    for col in score_cols:
        valid = df[col].notna()
        if valid.sum() > 0:
            print(f"    {col}: {df.loc[valid, col].mean():.2f}")
    
    return df

cycleable_roads_with_cl = aggregate_clos_attractiveness(cycleable_roads_with_cl)

# %% [markdown]
# ---
# ## 9. Junction Assessment Tool (JAT)

# %%
# [INSERT JAT pipeline here: build_node_table, identify_junction_modifiers,
#  compute_conflict_attributes, classify_crossing_junctions,
#  classify_roundabout_nodes, assign_jat_score_to_links, run_jat_pipeline]

# %% [markdown]
# ---
# ## 10. Overall CLoS Aggregate

# %%
def aggregate_clos_overall(df):
    """
    Combine Safety, Attractiveness, and JAT into a single CLoS percentage.
    All scored criteria contribute equally (each 0-2).
    """
    safety_cols = ['clos_s10', 'clos_s11', 'clos_s12', 'clos_s15']
    attract_cols = ['clos_a3', 'clos_a19', 'clos_a21', 'clos_a22', 'clos_a25']
    jat_cols = ['jat_score']
    
    all_cols = safety_cols + attract_cols + jat_cols
    
    df['clos_overall_n_scored'] = df[all_cols].notna().sum(axis=1)
    df['clos_overall_sum'] = df[all_cols].sum(axis=1, skipna=True)
    df['clos_overall_max'] = df['clos_overall_n_scored'] * 2
    df['clos_overall_pct'] = np.where(
        df['clos_overall_max'] > 0,
        (df['clos_overall_sum'] / df['clos_overall_max']) * 100,
        np.nan
    )
    
    scored = df['clos_overall_pct'].notna()
    pct = df.loc[scored, 'clos_overall_pct']
    print("=" * 60)
    print("CLoS OVERALL SUMMARY")
    print("=" * 60)
    print(f"  Links scored:      {scored.sum():,} / {len(df):,}")
    print(f"  Mean overall %:    {pct.mean():.1f}%")
    print(f"  Median overall %:  {pct.median():.1f}%")
    print(f"  Pass rate (>=70%): {(pct >= 70).sum():,} ({100 * (pct >= 70).mean():.1f}%)")
    
    print(f"\n  Sub-domain averages:")
    for label, cols in [('Safety', safety_cols),
                        ('Attractiveness', attract_cols),
                        ('JAT', jat_cols)]:
        vals = df[cols].mean(axis=1, skipna=True)
        valid = df[cols].notna().any(axis=1)
        if valid.sum() > 0:
            print(f"    {label}: {vals[valid].mean():.2f} / 2.0")
    
    return df

cycleable_roads_with_cl = aggregate_clos_overall(cycleable_roads_with_cl)

# %% [markdown]
# ---
# ## 11. Visualisation

# %%
fig, axes = plt.subplots(1, 3, figsize=(20, 6))

for ax, col, title in zip(axes,
    ['clos_safety_pct', 'clos_attract_pct', 'clos_overall_pct'],
    ['Safety Score (%)', 'Attractiveness Score (%)', 'Overall CLoS (%)']
):
    cycleable_roads_with_cl.plot(
        column=col, cmap='RdYlGn', legend=True,
        ax=ax, linewidth=0.3, missing_kwds={'color': 'lightgrey'}
    )
    ax.set_title(title)
    ax.set_axis_off()

plt.tight_layout()
plt.show()

# %% [markdown]
# ---
# ## 12. Export

# %%
# --- 12a. Network GeoPackage (all scores) ---
keep_cols = ['osid', 'geometry', 'facility_type',
             'startnode', 'endnode',
             'aadt', 'est_v85_mph',
             'roadwidth_average',
             'elevationgain_indirection', 'elevationgain_againstdirection',
             'presenceofstreetlight_coverage']

score_cols = sorted([c for c in cycleable_roads_with_cl.columns
                     if c.startswith('clos_') or c.startswith('jat_')])
keep_cols += score_cols

# Add auxiliary columns needed by web tool
aux_cols = ['poi_density', 'nearest_parking_m', 'nearest_protected_m',
            'gradient_pct', 'cyclelane_type',
            'cyclelaneinfo_minimumwidth_m', 'cyclelaneinfo_direction']
for c in aux_cols:
    if c in cycleable_roads_with_cl.columns:
        keep_cols.append(c)

keep_cols = [c for c in keep_cols if c in cycleable_roads_with_cl.columns]
export_df = cycleable_roads_with_cl[keep_cols].copy()

output_path = OUTPUT_DIR / "network_clos_scored.gpkg"
export_df.to_file(output_path, driver='GPKG')
print(f"Network exported: {output_path}")
print(f"  Links: {export_df.shape[0]:,} | Columns: {export_df.shape[1]}")

# %%
# --- 12b. POI GeoJSON (for web tool map layer) ---
poi_output = OUTPUT_DIR / "osm_pois.geojson"
pois_export = pois[['geometry']].copy()

# Recover POI type from original OSM tags
for tag in ['amenity', 'shop', 'office', 'leisure']:
    if tag in pois.columns:
        pois_export[tag] = pois[tag]

pois_export = pois_export.to_crs(CRS_WGS84)
pois_export.to_file(poi_output, driver='GeoJSON')
print(f"POIs exported: {poi_output} ({len(pois_export):,} features)")

# %%
# --- 12c. Cycle Parking GeoJSON (for web tool map layer) ---
parking_output = OUTPUT_DIR / "osm_cycle_parking.geojson"
parking_export = parking[['geometry']].copy()

for tag in ['capacity', 'bicycle_parking', 'covered']:
    if tag in parking.columns:
        parking_export[tag] = parking[tag]

parking_export = parking_export.to_crs(CRS_WGS84)
parking_export.to_file(parking_output, driver='GeoJSON')
print(f"Cycle parking exported: {parking_output} ({len(parking_export):,} features)")

# %%
# --- 12d. Column inventory ---
print(f"\nExported network columns ({len(keep_cols)}):")
for c in sorted(keep_cols):
    print(f"  {c}")
