const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Curated Media-Backed Starter Catalog
const BASE_CATALOG = [
  {
    id: "nahlula",
    heName: "נהלולה - עגלת קפה",
    enName: "Nahlula Coffee Cart",
    category: "coffee cart",
    lat: 32.7095, lng: 35.2104,
    locality: "Nahalal, Jezreel Valley",
    desc: "Cozy historic moshav spot with artisanal coffee, baked goods and healthy breakfast bites.",
    media: { source: "Haaretz Weekend", year: "2025", note: "Featured valley coffee spot" },
    secondaryRating: { value: 4.6, scale: 5, source: "Google", reviewCount: 380 },
    kosher: false, vegan: true, coffee: true,
    signature: "Fresh sourdough pastry & iced matcha latte"
  },
  {
    id: "hanodedet",
    heName: "הנודדת - עגלת אוכל",
    enName: "HaNodedet Food Truck",
    category: "food truck",
    lat: 32.5312, lng: 35.4831,
    locality: "Beit Alfa, Emek HaMaayanot",
    desc: "Relaxed outdoor spot serving fresh pastries, artisan coffee and light bites near the Gilboa.",
    media: { source: "Mako Travel", year: "2024", note: "Top valley food cart pick" },
    secondaryRating: { value: 4.7, scale: 5, source: "Google", reviewCount: 520 },
    kosher: false, vegan: true, coffee: true,
    signature: "Asado sandwich with chimichurri & fresh lemonade"
  },
  {
    id: "noyman",
    heName: "נוימן ברגר",
    enName: "Noyman's Burger",
    category: "food truck",
    lat: 32.5124, lng: 35.4521,
    locality: "Nir David, Route 71",
    desc: "Gourmet slow-smoked meats and burgers right off the valley stretch near Gan Guru.",
    media: { source: "Haaretz Food", year: "2025", note: "Recommended roadside smokehouse" },
    secondaryRating: { value: 4.5, scale: 5, source: "Google", reviewCount: 410 },
    kosher: false, vegan: false, coffee: false,
    signature: "Smoked brisket burger with secret sauce"
  },
  {
    id: "fika",
    heName: "FIKA בעמק",
    enName: "FIKA BaEmek",
    category: "coffee cart",
    lat: 32.5512, lng: 35.3789,
    locality: "Gid'ona, Gilboa Foothills",
    desc: "Swedish-infused café experience with cinnamon buns and open-air seating facing the valley.",
    media: { source: "Secret Tel Aviv", year: "2024", note: "Top northern scenic stop" },
    secondaryRating: { value: 4.8, scale: 5, source: "Google", reviewCount: 610 },
    kosher: false, vegan: true, coffee: true,
    signature: "Cardamom bun & Swedish filter coffee"
  }
];

// Helper: Haversine distance in KM
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Helper: Spatial projection & progress along polyline
function analyzeRouteCorridor(routeCoords, places) {
  let surviving = [];
  let dropped = 0;

  for (let place of places) {
    let minDistance = Infinity;
    let bestProgress = 0;
    let totalDist = 0;

    const segLens = [];
    for (let i = 0; i < routeCoords.length - 1; i++) {
      const d = getDistanceFromLatLonInKm(routeCoords[i][0], routeCoords[i][1], routeCoords[i+1][0], routeCoords[i+1][1]);
      segLens.push(d);
      totalDist += d;
    }

    let traversed = 0;
    for (let i = 0; i < routeCoords.length - 1; i++) {
      const A = routeCoords[i];
      const dSeg = segLens[i];

      const distToA = getDistanceFromLatLonInKm(place.lat, place.lng, A[0], A[1]);
      if (distToA < minDistance) {
        minDistance = distToA;
        bestProgress = totalDist > 0 ? traversed / totalDist : 0;
      }
      traversed += dSeg;
    }

    if (minDistance <= 3.0) { // Within 3 km band
      const detourMins = Math.round((minDistance * 2) + 2);
      surviving.push({
        ...place,
        detourKm: minDistance,
        detourMins: detourMins,
        progress: bestProgress
      });
    } else {
      dropped++;
    }
  }

  return { surviving, dropped };
}

// API Endpoint: Plan Route, Fetch OSM Open Data, Prune Closed Spots & Filter
app.post('/api/plan-route', async (req, res) => {
  try {
    const { origin, destination } = req.body;
    if (!origin || !destination) {
      return res.status(400).json({ error: "Origin and destination are required." });
    }

    // 1. Geocode Origin & Destination via Nominatim (with required User-Agent header)
    const geoRes = async (q) => {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=il&limit=1`, {
        headers: { 
          'Accept-Language': 'en',
          'User-Agent': 'RouteBiteIsraelApp/1.0 (contact@routebite.local)'
        }
      });
      const d = await r.json();
      if (!d || d.length === 0) throw new Error(`Location not found in Israel: "${q}"`);
      return { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) };
    };

    const orig = await geoRes(origin);
    const dest = await geoRes(destination);

    // 2. Request OSRM Driving Route[cite: 4]
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${orig.lon},${orig.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson`;
    const routeRes = await fetch(osrmUrl);
    const routeData = await routeRes.json();

    if (!routeData.routes || routeData.routes.length === 0) {
      return res.status(400).json({ error: "Could not calculate driving route." });
    }

    const route = routeData.routes[0];
    const routeCoords = route.geometry.coordinates.map(c => [c[1], c[0]]);

    // 3. Fetch Live OpenStreetMap Overpass Data along route bounding box[cite: 4]
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    routeCoords.forEach(c => {
      if (c[0] < minLat) minLat = c[0];
      if (c[0] > maxLat) maxLat = c[0];
      if (c[1] < minLon) minLon = c[1];
      if (c[1] > maxLon) maxLon = c[1];
    });

    minLat -= 0.05; maxLat += 0.05; minLon -= 0.05; maxLon += 0.05;

    const overpassQuery = `
      [out:json][timeout:25];
      (
        node["amenity"~"cafe|fast_food|restaurant"](${minLat},${minLon},${maxLat},${maxLon});
        way["amenity"~"cafe|fast_food|restaurant"](${minLat},${minLon},${maxLat},${maxLon});
      );
      out center;
    `;

    let dynamicCatalog = [...BASE_CATALOG];
    try {
      const ovRes = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: overpassQuery });
      const ovData = await ovRes.json();
      if (ovData && ovData.elements) {
        ovData.elements.forEach(el => {
          const tags = el.tags || {};
          // Automated Closure / Disused Pruning Filter[cite: 4]
          if (tags.disused === 'yes' || tags.abandoned === 'yes' || tags.closed === 'yes' || tags['disused:amenity']) {
            return;
          }
          const name = tags.name || tags['name:en'] || tags['name:he'];
          if (!name) return;
          const lat = el.lat || (el.center ? el.center.lat : null);
          const lon = el.lon || (el.center ? el.center.lon : null);
          if (!lat || !lon) return;

          const id = `osm_${el.id}`;
          if (!dynamicCatalog.some(c => c.id === id || c.heName === name)) {
            dynamicCatalog.push({
              id,
              heName: name,
              enName: tags['name:en'] || name,
              category: tags.amenity === 'cafe' ? 'coffee cart' : 'food truck',
              lat, lng: lon,
              locality: tags.addr_city || 'Roadside Corridor',
              desc: tags.description || 'Open-source community-mapped roadside stop.',
              media: null,
              secondaryRating: null,
              kosher: tags.kosher === 'yes',
              vegan: true,
              coffee: tags.amenity === 'cafe',
              signature: null
            });
          }
        });
      }
    } catch (e) {
      console.warn("Overpass fetch warning:", e.message);
    }

    // 4. Perform Spatial Filtering & Ranking[cite: 4]
    const { surviving, dropped } = analyzeRouteCorridor(routeCoords, dynamicCatalog);

    res.json({
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      routeCoords,
      surviving,
      dropped
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend client[cite: 4]
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`RouteBite server running live on port ${PORT}`);
});