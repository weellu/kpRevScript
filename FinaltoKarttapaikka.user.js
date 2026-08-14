// ==UserScript==
// @name         Final to karttapaikka + reviewer map
// @namespace    http://tampermonkey.net/
// @version      0.86
// @description  Add Kansalaisen Karttapaikka links and an interactive MML/OSM/Google map (waypoints, range rings, road-owner overlay, swine fever zones) to the geocache review page
// @author       Veli-Pekka Eloranta
// @match        https://*.geocaching.com/*
// @require      https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
// @resource     leafletCss https://unpkg.com/leaflet@1.9.4/dist/leaflet.css
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_getResourceText
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://github.com/weellu/kpRevScript/raw/main/FinaltoKarttapaikka.user.js
// @downloadURL  https://github.com/weellu/kpRevScript/raw/main/FinaltoKarttapaikka.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------------------------------------------------------
    // MML (Maanmittauslaitos) API key handling
    //
    // The key is stored in Tampermonkey storage, NOT in this file, so it is
    // never committed to the public repo. Set / change / clear it from the
    // Tampermonkey menu (the puzzle icon -> this script).
    // Get a personal key: https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje
    // ---------------------------------------------------------------------
    const KEY_STORE = 'mml_api_key';
    const PROMPTED_STORE = 'mml_api_key_prompted';

    let apiKey = GM_getValue(KEY_STORE, '');

    GM_registerMenuCommand('Set MML API key', function () {
        const v = prompt('Enter your MML (Maanmittauslaitos) API key:', GM_getValue(KEY_STORE, ''));
        if (v !== null) {
            GM_setValue(KEY_STORE, v.trim());
            GM_setValue(PROMPTED_STORE, true);
            location.reload();
        }
    });
    GM_registerMenuCommand('Clear MML API key', function () {
        GM_deleteValue(KEY_STORE);
        GM_deleteValue(PROMPTED_STORE);
        location.reload();
    });

    // ---------------------------------------------------------------------
    // Feature 1: Karttapaikka links next to each waypoint distance
    // (works on any page that has the waypoint distance cells)
    // ---------------------------------------------------------------------
    function karttapaikkaLink(lat, lon) {
        return 'https://asiointi.maanmittauslaitos.fi/karttapaikka/api/linkki?x=' + lat +
            '&y=' + lon + '&srs=EPSG:4258&scale=4000';
    }

    function addWaypointLinks() {
        const data = document.querySelector('#ctl00_ContentBody_CacheDataControl1_CacheData');
        if (!data) return;

        const spans = document.querySelectorAll(
            '[id^="ctl00_ContentBody_Waypoints_Waypoints_ctl"][id$="_uxDistance"]');
        if (!spans.length) return;

        spans.forEach(function (span, i) {
            const parentTd = span.closest('td');
            if (!parentTd || parentTd.querySelector('.kp-wp-link')) return;

            const lat = data.getAttribute('data-wp_' + i + '_latitude');
            const lon = data.getAttribute('data-wp_' + i + '_longitude');
            if (!lat || !lon) return;

            const link = document.createElement('a');
            link.className = 'kp-wp-link';
            link.href = karttapaikkaLink(lat, lon);
            link.textContent = 'View on Kansalaisen Karttapaikka';
            link.target = '_blank';
            link.style.display = 'block';
            link.style.marginLeft = '10px';
            link.style.textDecoration = 'none';
            link.style.color = '#0066cc';
            parentTd.appendChild(link);
        });
    }

    // ---------------------------------------------------------------------
    // Feature 2: Interactive map on the review page
    // ---------------------------------------------------------------------
    const waypointTypes = {
        217: 'Parking Area',
        218: 'Question to Answer',
        219: 'Stages of a Multicache',
        220: 'Final Location',
        221: 'Trailhead',
        452: 'Reference Point'
    };

    // ---------------------------------------------------------------------
    // Feature 3: African swine fever zones (afrikkalainen sikarutto, ASF)
    //
    // Ruokavirasto has established an infected zone (tartuntavyöhyke) around
    // the ASF findings in SE Finland, with a stricter core zone (ydinalue)
    // inside it. There is no official geodata service for the zones -- they
    // are published as PDF maps only -- so the rings below were rebuilt from
    // the decision text (korjattu päätös 14.8.2026,
    // dnro 5763/04.01.02.00.02/2026):
    //   * tartuntavyöhyke = Virolahti and Miehikkälä in full + the part of
    //     Lappeenranta south of the railway to Vainikkala (municipality
    //     borders and the railway taken from OpenStreetMap),
    //   * ydinalue = bounded in the west/north by Keipintie, Vaalimaantie,
    //     Mattilantie, Vaalimaanväylä, seututie 387 and Tohmonmäentie, in the
    //     east by the national border and in the south by the sea.
    // Both were checked against Ruokavirasto's official map (liite 1,
    // 13.8.2026): the outlines agree to ~97 % of the area. The rings are
    // therefore indicative -- always confirm from the official map before
    // making a publish decision, and update ASF_ZONES when the decision
    // changes.
    //
    // Ring coordinates are [lon, lat].
    // ---------------------------------------------------------------------
    const ASF_UPDATED = '14.8.2026';
    const ASF_INFO_URL = 'https://www.ruokavirasto.fi/elaimet/elainten-terveys-ja-elaintaudit/' +
        'elaintaudit/siat/afrikkalainen-sikarutto/asf-suomessa-2026/';
    const ASF_MAP_URL = 'https://www.ruokavirasto.fi/globalassets/elaimet/' +
        'elainten-terveys-ja-elaintaudit/elaintaudit/asf/liite-bilaga-1-130826.pdf';

    const ASF_ZONES = {
        tartuntavyohyke: [
            [27.99537,60.67121],[27.87343,60.60455],[27.84795,60.5824],[27.84775,60.58179],[27.84461,60.58074],[27.84373,60.5799],
            [27.84136,60.58005],[27.84007,60.57929],[27.84003,60.57884],[27.83844,60.57846],[27.83857,60.57773],[27.84087,60.57733],
            [27.84466,60.57487],[27.84405,60.5725],[27.8422,60.56936],[27.84174,60.56909],[27.84291,60.56705],[27.84208,60.56618],
            [27.8439,60.56321],[27.8454,60.56221],[27.84739,60.56144],[27.8144,60.55427],[27.79666,60.54564],[27.77441,60.53358],
            [27.77663,60.50768],[27.76831,60.50387],[27.76488,60.49548],[27.76819,60.48906],[27.75649,60.47177],[27.74825,60.46922],
            [27.74795,60.45117],[27.69439,60.43757],[27.68692,60.43357],[27.72577,60.39168],[27.66979,60.35712],[27.55696,60.38744],
            [27.53319,60.41047],[27.52069,60.42409],[27.52255,60.43433],[27.53472,60.4399],[27.49987,60.45246],[27.43633,60.4599],
            [27.39804,60.47478],[27.40674,60.48398],[27.39988,60.50724],[27.39827,60.51166],[27.39778,60.51759],[27.38706,60.52355],
            [27.38032,60.52869],[27.35659,60.55877],[27.35972,60.56596],[27.36285,60.56977],[27.37375,60.58587],[27.38787,60.60221],
            [27.4222,60.62844],[27.44121,60.63517],[27.45463,60.64085],[27.45238,60.65043],[27.45449,60.65541],[27.45766,60.66143],
            [27.44578,60.67973],[27.44407,60.68606],[27.43575,60.6944],[27.42186,60.70389],[27.42778,60.7104],[27.43599,60.726],
            [27.43964,60.73041],[27.44707,60.75276],[27.44264,60.76847],[27.43667,60.77745],[27.43245,60.78299],[27.4302,60.78956],
            [27.43098,60.79409],[27.4244,60.80895],[27.423,60.81824],[27.42837,60.84262],[27.45282,60.8206],[27.48637,60.807],
            [27.50473,60.79922],[27.54962,60.79785],[27.57828,60.80261],[27.58823,60.80392],[27.60089,60.80446],[27.6061,60.80586],
            [27.62723,60.80478],[27.65287,60.80265],[27.66423,60.80121],[27.67825,60.80165],[27.68575,60.80035],[27.68985,60.79906],
            [27.70326,60.79598],[27.71384,60.79533],[27.71574,60.79637],[27.7186,60.80021],[27.72116,60.79942],[27.72133,60.79982],
            [27.72006,60.80068],[27.71895,60.80079],[27.71894,60.81181],[27.71866,60.81461],[27.71738,60.81751],[27.72005,60.81791],
            [27.72127,60.81744],[27.72183,60.81679],[27.72352,60.81698],[27.7248,60.81672],[27.75071,60.81627],[27.74572,60.81975],
            [27.74649,60.82929],[27.7437,60.83164],[27.76688,60.83374],[27.76707,60.83333],[27.7651,60.82947],[27.75999,60.82555],
            [27.76076,60.82422],[27.80849,60.82313],[27.81206,60.82184],[27.81576,60.8219],[27.84558,60.82471],[27.83688,60.82932],
            [27.84692,60.83548],[27.87622,60.84859],[27.8638,60.85464],[27.86455,60.85483],[27.85766,60.85856],[27.8574,60.85828],
            [27.85497,60.86002],[27.87172,60.87532],[27.88338,60.87811],[27.89475,60.88687],[27.89969,60.87564],[27.90117,60.87372],
            [27.88342,60.86535],[27.88467,60.86433],[27.885,60.86341],[27.88606,60.8623],[27.8889,60.85153],[27.89476,60.84885],
            [27.89328,60.84792],[27.89351,60.84754],[27.89515,60.84742],[27.89627,60.84793],[27.9011,60.84779],[27.90457,60.85014],
            [27.90534,60.85322],[27.90435,60.85579],[27.91158,60.85803],[27.92665,60.87042],[27.93175,60.87578],[27.93321,60.87932],
            [27.93126,60.87968],[27.93198,60.88416],[27.91534,60.8866],[27.90347,60.89087],[27.90111,60.89107],[27.89134,60.90885],
            [27.8945,60.91604],[27.90248,60.92783],[27.90201,60.92885],[27.90152,60.93254],[27.90593,60.93192],[27.91236,60.9319],
            [27.92965,60.93304],[27.93763,60.93307],[27.94168,60.93278],[27.9538,60.93013],[27.9827,60.92593],[27.99627,60.92543],
            [27.99926,60.92568],[28.00583,60.92689],[28.00891,60.92708],[28.01664,60.92642],[28.02232,60.92548],[28.04231,60.92104],
            [28.06088,60.91791],[28.07578,60.91484],[28.09127,60.91278],[28.12476,60.91119],[28.12796,60.91064],[28.13578,60.90851],
            [28.14149,60.90756],[28.15152,60.90728],[28.16721,60.91045],[28.1699,60.91067],[28.17311,60.91042],[28.18388,60.90728],
            [28.18803,60.90573],[28.20695,60.8963],[28.22151,60.88736],[28.22669,60.88513],[28.2401,60.88138],[28.25071,60.87783],
            [28.25798,60.87586],[28.26643,60.87406],[28.29426,60.8657],[28.30782,60.86287],[28.33778,60.85529],[28.33565,60.85414],
            [28.33482,60.85498],[28.33216,60.85553],[28.33072,60.85623],[28.32771,60.8561],[28.32509,60.85769],[28.32423,60.85791],
            [28.31191,60.84127],[28.25584,60.80995],[28.22049,60.78279],[28.17428,60.77862],[28.13546,60.74087],[28.08899,60.7206],
            [28.03804,60.69403],[28.01517,60.68244],[28.01783,60.68118],[27.99808,60.67041],[27.99537,60.67121]
        ],
        ydinalue: [
            [27.87352,60.6046],[27.84795,60.5824],[27.84775,60.58179],[27.84216,60.5817],[27.84212,60.5801],[27.84101,60.57986],
            [27.84007,60.57929],[27.84003,60.57884],[27.83844,60.57846],[27.83857,60.57773],[27.84087,60.57733],[27.84203,60.57662],
            [27.84167,60.56308],[27.83559,60.56016],[27.8211,60.5567],[27.81389,60.55675],[27.81265,60.55498],[27.80171,60.54973],
            [27.79931,60.54974],[27.79567,60.54799],[27.79564,60.54681],[27.79199,60.54505],[27.78239,60.54511],[27.77883,60.54691],
            [27.77415,60.55166],[27.7742,60.55403],[27.77183,60.55522],[27.77214,60.56823],[27.76742,60.5718],[27.76748,60.57417],
            [27.76513,60.57654],[27.75801,60.58013],[27.75803,60.58131],[27.75727,60.5817],[27.7511,60.5817],[27.75108,60.5826],
            [27.75007,60.58387],[27.75028,60.58425],[27.7477,60.58658],[27.74472,60.58837],[27.74463,60.58973],[27.74806,60.59051],
            [27.74739,60.59212],[27.74586,60.59355],[27.74618,60.5951],[27.75033,60.59769],[27.7527,60.59868],[27.75416,60.60288],
            [27.75596,60.60476],[27.75586,60.60569],[27.76642,60.60718],[27.77364,60.60884],[27.7837,60.61165],[27.7913,60.61285],
            [27.79765,60.61306],[27.80384,60.61258],[27.81018,60.61159],[27.81643,60.61007],[27.81681,60.61137],[27.82374,60.61302],
            [27.8273,60.6144],[27.82984,60.61594],[27.83146,60.61745],[27.83261,60.6194],[27.83341,60.62235],[27.83505,60.62433],
            [27.83672,60.62552],[27.84337,60.62906],[27.84921,60.63278],[27.85519,60.63542],[27.86014,60.63665],[27.87156,60.63752],
            [27.87437,60.6382],[27.87657,60.63931],[27.87838,60.64097],[27.88029,60.64431],[27.88805,60.64896],[27.8894,60.65042],
            [27.88958,60.6519],[27.88549,60.65684],[27.88573,60.65791],[27.88826,60.66054],[27.89298,60.66004],[27.89515,60.65897],
            [27.89617,60.6576],[27.89821,60.65687],[27.90391,60.65691],[27.90495,60.65513],[27.90386,60.65408],[27.90402,60.65355],
            [27.90852,60.65082],[27.91227,60.64932],[27.91245,60.64852],[27.91327,60.64737],[27.91776,60.64614],[27.93004,60.63545],
            [27.87352,60.6046]
        ]
    };

    // Precomputed bounding boxes, so the usual (non-Finnish-SE) cache is
    // rejected with four comparisons instead of a full ray cast.
    const ASF_BBOX = {};
    Object.keys(ASF_ZONES).forEach(function (key) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        ASF_ZONES[key].forEach(function (c) {
            if (c[0] < minX) minX = c[0];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[1] > maxY) maxY = c[1];
        });
        ASF_BBOX[key] = [minX, minY, maxX, maxY];
    });

    function inBBox(lat, lon, bbox, pad) {
        const p = pad || 0;
        return lon >= bbox[0] - p && lon <= bbox[2] + p &&
               lat >= bbox[1] - p && lat <= bbox[3] + p;
    }

    // Ray casting; the rings are small enough that plain WGS84 degrees are
    // accurate to well under a metre here.
    function pointInRing(lat, lon, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            if ((yi > lat) !== (yj > lat) &&
                lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Returns 'ydinalue', 'tartuntavyohyke' or null. The core zone is checked
    // first because it lies inside the infected zone.
    function asfZoneAt(lat, lon) {
        if (inBBox(lat, lon, ASF_BBOX.ydinalue) &&
            pointInRing(lat, lon, ASF_ZONES.ydinalue)) {
            return 'ydinalue';
        }
        if (inBBox(lat, lon, ASF_BBOX.tartuntavyohyke) &&
            pointInRing(lat, lon, ASF_ZONES.tartuntavyohyke)) {
            return 'tartuntavyohyke';
        }
        return null;
    }

    function asfLatLngs(ring) {
        return ring.map(function (c) { return [c[1], c[0]]; });
    }

    function streetViewLink(lat, lon) {
        return '<a target="_blank" href="https://maps.google.com/maps?cbp=0,0,0,0,0&layer=c&ll=' +
            lat + ',' + lon + '&cbll=' + lat + ',' + lon + '&q=' + lat + ',' + lon + '">StreetView</a>';
    }

    function pinIcon(typeId) {
        return L.icon({
            iconUrl: '../images/wpttypes/pins/' + typeId + '.png',
            iconSize: [20, 23],
            iconAnchor: [10, 23],
            shadowUrl: null
        });
    }

    function buildMap() {
        const data = document.querySelector('#ctl00_ContentBody_CacheDataControl1_CacheData');
        if (!data) return;

        const latitude = parseFloat(data.getAttribute('data-latitude'));
        const longitude = parseFloat(data.getAttribute('data-longitude'));
        if (isNaN(latitude) || isNaN(longitude)) return;

        const waypointCount = parseInt(data.getAttribute('data-wp_count'), 10) || 0;
        const cacheTypeId = data.getAttribute('data-cachetypeid');

        // Inject Leaflet CSS (fetched by the userscript manager, so CSP-safe)
        try {
            GM_addStyle(GM_getResourceText('leafletCss'));
        } catch (e) {
            const l = document.createElement('link');
            l.rel = 'stylesheet';
            l.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
            document.head.appendChild(l);
        }
        GM_addStyle(
            '#kp-map{height:400px;margin:10px 0;border:1px solid #ccc;}' +
            // Leaflet's CSS points the layers-control icon at a relative image
            // path that 404s when injected into the review page, leaving a blank
            // white button. Point it at the absolute CDN images instead.
            '.leaflet-control-layers-toggle{' +
            'background-image:url(https://unpkg.com/leaflet@1.9.4/dist/images/layers.png);}' +
            '.leaflet-retina .leaflet-control-layers-toggle{' +
            'background-image:url(https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png);background-size:26px 26px;}' +
            '.kp-legend{background:rgba(255,255,255,0.85);padding:4px 6px;border:1px solid #ccc;border-radius:4px;}' +
            '.kp-legend img{display:block;}' +
            // Match the layer-control's size in both normal and Leaflet's
            // "touch" mode (where Leaflet scales its own controls 36->44px).
            '.kp-road-control{background:#fff;border-radius:5px;box-shadow:0 1px 5px rgba(0,0,0,0.4);}' +
            '.leaflet-touch .kp-road-control{border:2px solid rgba(0,0,0,0.2);box-shadow:none;}' +
            '.kp-road-control a{width:36px;height:36px;display:flex;align-items:center;' +
            'justify-content:center;color:#333;cursor:pointer;border-radius:5px;}' +
            '.leaflet-touch .kp-road-control a{width:44px;height:44px;}' +
            '.kp-road-control a.active{background:#4a90d9;color:#fff;}' +
            // (The old .kp-cadastral red-recolour filter is gone: the INSPIRE
            // WMS that rendered the boundaries in flat black was shut down, and
            // its WMTS replacement already ships MML's own cadastral styling.)
            '.kp-measure-tip{background:#fff;border:1px solid #4dabf7;color:#0b60b0;' +
            'font-weight:bold;padding:1px 6px;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,0.3);}' +
            '.kp-measure-tip:before{display:none;}' +
            // ASF warning. The two zones get deliberately different colours,
            // matching the polygon shades on the map: deep red = ydinalue
            // (strictest), orange = tartuntavyöhyke.
            '.kp-asf-warn{margin:10px 0;border:2px solid;border-radius:4px;' +
            'overflow:hidden;font-size:13px;line-height:1.45;}' +
            '.kp-asf-warn .kp-asf-head{padding:7px 12px;color:#fff;font-weight:bold;' +
            'font-size:15px;letter-spacing:0.4px;}' +
            '.kp-asf-warn .kp-asf-body{padding:9px 12px;}' +
            '.kp-asf-warn ul{margin:7px 0 0 18px;padding:0;}' +
            '.kp-asf-warn li{margin:2px 0;}' +
            '.kp-asf-warn .kp-asf-where{font-weight:bold;}' +
            '.kp-asf-warn .kp-asf-note{display:block;margin-top:9px;font-weight:normal;' +
            'font-size:11px;line-height:1.4;color:#666;}' +
            '.kp-asf-warn .kp-asf-note a{color:#666;}' +
            '.kp-asf-core{border-color:#8b1a00;background:#ffeceb;color:#5c1000;}' +
            '.kp-asf-core .kp-asf-head{background:#8b1a00;}' +
            '.kp-asf-core a{color:#8b1a00;}' +
            '.kp-asf-zone{border-color:#b35806;background:#fff5e8;color:#6b3505;}' +
            '.kp-asf-zone .kp-asf-head{background:#b35806;}' +
            '.kp-asf-zone a{color:#b35806;}');

        // Insert the map container in a sensible place on the review page
        const mapDiv = document.createElement('div');
        mapDiv.id = 'kp-map';
        const anchor =
            document.querySelector('#ctl00_ContentBody_CacheDetails_AdditionalDetails') ||
            document.querySelector('#ctl00_ContentBody_uxWaypoints') ||
            document.querySelector('#ctl00_ContentBody_CacheDataControl1_CacheData');
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(mapDiv, anchor);
        } else {
            document.body.insertBefore(mapDiv, document.body.firstChild);
        }

        const map = L.map('kp-map');

        // Custom panes, so the overlays stack in a predictable order. Leaflet
        // puts every tile layer in tilePane (z 200) and every vector in
        // overlayPane (z 400), which would paint the translucent ASF fill on
        // top of the cadastral / road-owner lines and wash them out. Instead:
        // ASF shading just above the base map, the two WMS overlays above it.
        map.createPane('kpAsf').style.zIndex = 250;
        map.createPane('kpWms').style.zIndex = 350;

        // --- Base layers -------------------------------------------------
        const mmlUrl = function (layer) {
            return 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/' + layer +
                '/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.png?api-key=' + apiKey;
        };
        const mmlAttr = '&copy; Maanmittauslaitos';

        const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors'
        });

        const googleLayer = function (lyrs) {
            return L.tileLayer('https://mt{s}.google.com/vt/lyrs=' + lyrs + '&x={x}&y={y}&z={z}', {
                maxZoom: 20,
                subdomains: '0123',
                attribution: '&copy; Google'
            });
        };
        const gRoads   = googleLayer('m');
        const gSat     = googleLayer('s');
        const gHybrid  = googleLayer('y');
        const gTerrain = googleLayer('p');

        const baseMaps = {};
        let defaultLayer = osm;

        if (apiKey) {
            const maastokartta = L.tileLayer(mmlUrl('maastokartta'), { maxZoom: 18, attribution: mmlAttr });
            const taustakartta = L.tileLayer(mmlUrl('taustakartta'), { maxZoom: 18, attribution: mmlAttr });
            const ortokuva     = L.tileLayer(mmlUrl('ortokuva'),     { maxZoom: 18, attribution: mmlAttr });

            baseMaps['Maastokartta (MML)'] = maastokartta;
            baseMaps['Taustakartta (MML)'] = taustakartta;
            baseMaps['Ilmakuva (MML)'] = ortokuva;
            defaultLayer = maastokartta;

            // Automatic fallback to OSM if the MML tiles fail (bad/expired key,
            // referrer restriction, service down, ...)
            let fellBack = false;
            [maastokartta, taustakartta, ortokuva].forEach(function (layer) {
                layer.on('tileerror', function () {
                    if (fellBack || !map.hasLayer(layer)) return;
                    fellBack = true;
                    console.warn('[kpRevScript] MML tiles failed to load, falling back to OpenStreetMap. Check your MML API key.');
                    map.removeLayer(layer);
                    osm.addTo(map);
                });
            });
        }
        baseMaps['OpenStreetMap'] = osm;
        baseMaps['Google Maps'] = gRoads;
        baseMaps['Google Satelliitti'] = gSat;
        baseMaps['Google Hybridi'] = gHybrid;
        baseMaps['Google Maasto'] = gTerrain;

        defaultLayer.addTo(map);
        map.setView([latitude, longitude], 15);

        // Track the active base layer so the road-owner toggle can restore it.
        let currentBase = defaultLayer;
        map.on('baselayerchange', function (e) {
            currentBase = e.layer;
            if (map.hasLayer(roadOwners)) { roadOwners.bringToFront(); }
        });
        function setBase(layer) {
            if (currentBase && map.hasLayer(currentBase)) { map.removeLayer(currentBase); }
            layer.addTo(map);
            currentBase = layer;
            if (map.hasLayer(roadOwners)) { roadOwners.bringToFront(); }
        }

        // --- Overlay: range rings ----------------------------------------
        const rangeLayer = L.layerGroup();

        // --- Overlay: road owners (Väylävirasto Digiroad, open WMS) ------
        // "Tiestön omistajat" = hallinnollinen luokka: valtio / kunta /
        // yksityinen. NB: the capabilities name (DR_Tielinkki_...) errors on
        // GetMap; the renderable layer is the lowercase dr_tielinkki_hall_lk.
        // Only drawn when zoomed in (server MaxScaleDenominator = 1:100000).
        const digiroadOws = 'https://avoinapi.vaylapilvi.fi/vaylatiedot/digiroad/ows';
        const roadOwners = L.tileLayer.wms(digiroadOws, {
            layers: 'dr_tielinkki_hall_lk',
            format: 'image/png',
            transparent: true,
            version: '1.3.0',
            maxZoom: 20,
            opacity: 0.8,
            pane: 'kpWms',
            attribution: '&copy; Väylävirasto, Digiroad'
        });

        // --- Overlay: cadastral boundaries (MML karttakuvapalvelu WMTS) --
        // "Kiinteistörajat" — the same boundaries shown in Kansalaisen
        // Karttapaikka.
        //
        // This used to come from the keyless INSPIRE WMS at
        // inspire-wms.maanmittauslaitos.fi/inspire-wms/cp/wms. That service has
        // been shut down (the host now refuses connections outright), so the
        // layer is taken from the same open WMTS as the MML base maps and needs
        // the API key. It is served as a transparent PNG8 in MML's own cadastral
        // styling, so no client-side recolouring is needed any more.
        //
        // The open service only has zoom levels 12-16 in WGS84_Pseudo-Mercator
        // (contract customers get 12-18). maxNativeZoom lets Leaflet upscale the
        // z16 tiles past that instead of requesting tiles that do not exist.
        const cadastral = L.tileLayer(mmlUrl('kiinteistojaotus'), {
            minZoom: 12,
            maxNativeZoom: 16,
            maxZoom: 20,
            pane: 'kpWms',
            attribution: '&copy; Maanmittauslaitos'
        });

        // --- Overlay: ASF zones (afrikkalainen sikarutto) ----------------
        // Drawn from the baked-in rings, see ASF_ZONES above. The core zone
        // is drawn last so it stays clickable on top of the infected zone.
        // The two zones use the same colours as the warning banners below, so
        // the banner tells you at a glance which shade on the map you are in.
        const asfLayer = L.layerGroup();
        const asfInfected = L.polygon(asfLatLngs(ASF_ZONES.tartuntavyohyke), {
            pane: 'kpAsf',
            color: '#b35806', weight: 4, opacity: 0.95,
            fillColor: '#f16913', fillOpacity: 0.30
        });
        const asfCore = L.polygon(asfLatLngs(ASF_ZONES.ydinalue), {
            pane: 'kpAsf',
            color: '#7f2704', weight: 4, opacity: 1,
            fillColor: '#a63603', fillOpacity: 0.28
        });

        // The fill has two jobs that pull in opposite directions: zoomed out it
        // has to show at a glance where the zones are, zoomed in it must not
        // bury the terrain the reviewer is actually looking at. So scale it
        // with the zoom level instead of picking one compromise value.
        function styleAsfForZoom() {
            const z = map.getZoom();
            const base = z >= 15 ? 0.15 : z >= 13 ? 0.22 : z >= 11 ? 0.30 : 0.36;
            asfInfected.setStyle({ fillOpacity: base });
            asfCore.setStyle({ fillOpacity: Math.min(0.55, base * 1.85) });
        }
        map.on('zoomend', styleAsfForZoom);
        // No popups on the polygons: the restrictions are already spelled out
        // in the warning above the map, and a click-through callout on a shape
        // that covers half the view just gets in the way.
        asfLayer.addLayer(asfInfected);
        asfLayer.addLayer(asfCore);

        const overlayMaps = {
            'Etäisyysrenkaat': rangeLayer,
            'Sikaruttovyöhykkeet': asfLayer
        };
        L.control.layers(baseMaps, overlayMaps).addTo(map);

        // Legend for the road-owner overlay, shown only while it is active.
        const ownerLegend = L.control({ position: 'bottomleft' });
        ownerLegend.onAdd = function () {
            const div = L.DomUtil.create('div', 'kp-legend');
            div.innerHTML = '<img alt="Tiestön omistajat" src="' + digiroadOws +
                '?service=WMS&version=1.3.0&request=GetLegendGraphic&format=image/png&layer=dr_tielinkki_hall_lk">';
            return div;
        };

        // --- Road-owner toggle control (below the layer selector) --------
        // A Leaflet control in the same top-right corner as the layer
        // switcher: pressing it forces Google Maps as the base (roads are
        // clearest there), shows the road-owner overlay + its legend, and
        // remembers the previous base. Pressing again hides the overlay and
        // restores whatever base was active before.
        // Road icon (inline SVG, uses currentColor so it inverts when active).
        const ROAD_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
            '<path d="M7 3 5 21M17 3l2 18M12 4v3M12 10.5v3M12 17v3"/></svg>';

        let roadOwnersActive = false;
        let preToggleBase = null;
        let roadLink = null;

        function toggleRoadOwners() {
            roadOwnersActive = !roadOwnersActive;
            if (roadOwnersActive) {
                preToggleBase = currentBase;
                setBase(gRoads);
                roadOwners.addTo(map);
                roadOwners.bringToFront();
                ownerLegend.addTo(map);
                if (roadLink) {
                    roadLink.title = 'Piilota tiestön omistajat';
                    roadLink.classList.add('active');
                }
            } else {
                if (map.hasLayer(roadOwners)) { map.removeLayer(roadOwners); }
                map.removeControl(ownerLegend);
                if (preToggleBase) { setBase(preToggleBase); }
                if (roadLink) {
                    roadLink.title = 'Näytä tiestön omistajat';
                    roadLink.classList.remove('active');
                }
            }
        }

        const RoadControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                roadLink = L.DomUtil.create('a', '', container);
                roadLink.href = '#';
                roadLink.title = 'Näytä tiestön omistajat';
                roadLink.setAttribute('aria-label', 'Tiestön omistajat');
                roadLink.innerHTML = ROAD_ICON;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(roadLink, 'click', function (e) {
                    L.DomEvent.preventDefault(e);
                    toggleRoadOwners();
                });
                return container;
            }
        });
        map.addControl(new RoadControl());

        // --- Cadastral-boundary toggle control (below the road button) ---
        // Simple on/off overlay: just adds/removes the property boundaries on
        // top of the current map, without changing the base layer.
        const CAD_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M3 3h18v18H3z"/><path d="M3 10h9M12 3v14M12 14h9"/></svg>';

        let cadastralActive = false;
        let cadLink = null;

        function toggleCadastral() {
            cadastralActive = !cadastralActive;
            if (cadastralActive) {
                cadastral.addTo(map);
                cadastral.bringToFront();
                if (cadLink) {
                    cadLink.title = 'Piilota kiinteistörajat';
                    cadLink.classList.add('active');
                }
            } else {
                if (map.hasLayer(cadastral)) { map.removeLayer(cadastral); }
                if (cadLink) {
                    cadLink.title = 'Näytä kiinteistörajat';
                    cadLink.classList.remove('active');
                }
            }
        }

        const CadControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                cadLink = L.DomUtil.create('a', '', container);
                cadLink.href = '#';
                cadLink.title = 'Näytä kiinteistörajat';
                cadLink.setAttribute('aria-label', 'Kiinteistörajat');
                cadLink.innerHTML = CAD_ICON;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(cadLink, 'click', function (e) {
                    L.DomEvent.preventDefault(e);
                    toggleCadastral();
                });
                return container;
            }
        });
        // The WMTS cadastral layer needs the MML API key, so without one there
        // is nothing the button could show. (Neither are the MML base maps
        // available in that case, so a missing button is consistent.)
        if (apiKey) {
            map.addControl(new CadControl());
        }

        // --- Distance measurement tool (below the cadastral button) ------
        // Two-point measurement that snaps to the known points (cache zero
        // point + all waypoints, collected in measurePoints). Activate ->
        // click a start point (snaps to the nearest known point if you click
        // near one) -> a light-blue rubber-band line follows the cursor with a
        // live distance tooltip (the end also snaps) -> click again to lock.
        // The line stays; pressing the button again resets / starts anew.
        const MEASURE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M14.5 2.5 21.5 9.5 9.5 21.5 2.5 14.5z"/>' +
            '<path d="M7 11l1.5 1.5M10 8l1.5 1.5M13 5l1.5 1.5"/></svg>';

        // Known snap targets: cache zero point first, waypoints pushed below.
        const measurePoints = [L.latLng(latitude, longitude)];
        const SNAP_PX = 20;
        let measureActive = false;
        let measureStart = null;
        let measureLine = null;
        let measureTip = null;
        let measLink = null;

        function fmtDist(m) {
            return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
        }
        function snapLatLng(latlng) {
            const p = map.latLngToContainerPoint(latlng);
            let best = latlng, bestPx = SNAP_PX;
            measurePoints.forEach(function (kp) {
                const d = p.distanceTo(map.latLngToContainerPoint(kp));
                if (d <= bestPx) { bestPx = d; best = kp; }
            });
            return best;
        }
        function clearMeasure() {
            if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
            if (measureTip) { map.removeLayer(measureTip); measureTip = null; }
            measureStart = null;
        }
        function measureDraw(from, to, locked) {
            const dash = locked ? null : '6,6';
            if (!measureLine) {
                measureLine = L.polyline([from, to], {
                    color: '#4dabf7', weight: 3, opacity: 0.9, dashArray: dash
                }).addTo(map);
            } else {
                measureLine.setLatLngs([from, to]);
                measureLine.setStyle({ dashArray: dash });
            }
            const content = fmtDist(map.distance(from, to));
            if (!measureTip) {
                measureTip = L.tooltip({ permanent: true, direction: 'top', offset: [0, -6], className: 'kp-measure-tip' })
                    .setLatLng(to).setContent(content);
                measureTip.addTo(map);
            } else {
                measureTip.setLatLng(to).setContent(content);
            }
        }
        function onMeasureMove(e) {
            if (!measureStart) return;
            measureDraw(measureStart, snapLatLng(e.latlng), false);
        }
        function onMeasureClick(e) {
            const pt = snapLatLng(e.latlng);
            if (!measureStart) {
                measureStart = pt;                 // first click sets the start point
                return;
            }
            measureDraw(measureStart, pt, true);   // second click locks the line
            stopMeasureMode();                     // line + tooltip stay on the map
        }
        function stopMeasureMode() {
            map.off('mousemove', onMeasureMove);
            map.off('click', onMeasureClick);
            map.getContainer().style.cursor = '';
            measureActive = false;
            if (measLink) { measLink.classList.remove('active'); measLink.title = 'Mittaa etäisyys'; }
        }
        function toggleMeasure() {
            if (measureActive) {           // pressing while measuring = cancel + clear
                stopMeasureMode();
                clearMeasure();
                return;
            }
            clearMeasure();                // fresh start: reset any previous line
            measureActive = true;
            if (measLink) { measLink.classList.add('active'); measLink.title = 'Lopeta / nollaa mittaus'; }
            map.getContainer().style.cursor = 'crosshair';
            map.on('mousemove', onMeasureMove);
            map.on('click', onMeasureClick);
        }

        const MeasureControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                measLink = L.DomUtil.create('a', '', container);
                measLink.href = '#';
                measLink.title = 'Mittaa etäisyys';
                measLink.setAttribute('aria-label', 'Mittaa etäisyys');
                measLink.innerHTML = MEASURE_ICON;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(measLink, 'click', function (e) {
                    L.DomEvent.preventDefault(e);
                    toggleMeasure();
                });
                return container;
            }
        });
        map.addControl(new MeasureControl());

        // --- Swine-fever zone toggle control (below the measure button) --
        // The same layer is also in the layer selector; the two stay in sync
        // because the button state is driven by the map's layeradd/layerremove
        // events rather than by the click handler.
        const ASF_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 3 2.5 20h19z"/><path d="M12 9.5v4.4M12 17.1v.1"/></svg>';

        let asfLink = null;

        function updateAsfButton() {
            if (!asfLink) return;
            const on = map.hasLayer(asfLayer);
            asfLink.title = on ? 'Piilota sikaruttovyöhykkeet' : 'Näytä sikaruttovyöhykkeet';
            asfLink.classList.toggle('active', on);
        }
        map.on('layeradd layerremove', function (e) {
            if (e.layer === asfLayer) { updateAsfButton(); }
        });

        const AsfControl = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                const container = L.DomUtil.create('div', 'leaflet-control kp-road-control');
                asfLink = L.DomUtil.create('a', '', container);
                asfLink.href = '#';
                asfLink.setAttribute('aria-label', 'Sikaruttovyöhykkeet');
                asfLink.innerHTML = ASF_ICON;
                updateAsfButton();
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(asfLink, 'click', function (e) {
                    L.DomEvent.preventDefault(e);
                    if (map.hasLayer(asfLayer)) {
                        map.removeLayer(asfLayer);
                    } else {
                        asfLayer.addTo(map);
                        asfInfected.bringToBack();
                    }
                });
                return container;
            }
        });
        map.addControl(new AsfControl());

        function addRange(latlng) {
            for (let r = 1; r <= 161; r += 10) {
                const circle = L.circle(latlng, {
                    radius: r,
                    color: 'red',
                    fill: false,
                    weight: 1,
                    opacity: 0.5
                });
                circle.bindPopup(r + ' metriä nollapisteestä');
                rangeLayer.addLayer(circle);
            }
        }

        // --- Cache marker ------------------------------------------------
        const bounds = L.latLngBounds([[latitude, longitude]]);
        const asfPoints = [{ label: 'Nollapiste', lat: latitude, lon: longitude }];

        const cacheMarker = L.marker([latitude, longitude], { icon: pinIcon(cacheTypeId) }).addTo(map);
        cacheMarker.bindPopup(
            'Latitude: ' + latitude + '<br/>Longitude: ' + longitude +
            '<br/><a target="_blank" href="' + karttapaikkaLink(latitude, longitude) + '">Karttapaikka</a>' +
            '<br/>' + streetViewLink(latitude, longitude));
        addRange([latitude, longitude]);

        // --- Waypoint markers --------------------------------------------
        for (let i = 0; i < waypointCount; i++) {
            const wpLat = parseFloat(data.getAttribute('data-wp_' + i + '_latitude'));
            const wpLon = parseFloat(data.getAttribute('data-wp_' + i + '_longitude'));
            if (isNaN(wpLat) || isNaN(wpLon)) continue;

            const wpTypeId = data.getAttribute('data-wp_' + i + '_type');
            const wpType = waypointTypes[wpTypeId] || 'Waypoint';

            const wpMarker = L.marker([wpLat, wpLon], { icon: pinIcon(wpTypeId) }).addTo(map);
            wpMarker.bindPopup(
                wpType + '<br/>Latitude: ' + wpLat + '<br/>Longitude: ' + wpLon +
                '<br/><a target="_blank" href="' + karttapaikkaLink(wpLat, wpLon) + '">Karttapaikka</a>' +
                '<br/>' + streetViewLink(wpLat, wpLon));
            addRange([wpLat, wpLon]);
            bounds.extend([wpLat, wpLon]);
            measurePoints.push(L.latLng(wpLat, wpLon)); // snap target for measuring
            asfPoints.push({ label: wpType, lat: wpLat, lon: wpLon });
        }

        if (waypointCount > 0) {
            map.fitBounds(bounds.pad(0.2));
        }

        // --- ASF check: warn in red if any point is inside a zone --------
        // The overlay is switched on automatically whenever the cache is in
        // the neighbourhood of the infected zone, so the reviewer sees the
        // zone even when the cache itself falls just outside it.
        const asfHits = [];
        let asfNear = false;
        asfPoints.forEach(function (p) {
            const zone = asfZoneAt(p.lat, p.lon);
            if (zone) { asfHits.push({ point: p, zone: zone }); }
            if (inBBox(p.lat, p.lon, ASF_BBOX.tartuntavyohyke, 0.25)) { asfNear = true; }
        });

        if (asfNear) {
            asfLayer.addTo(map);
            asfInfected.bringToBack();
        }
        styleAsfForZoom();   // the view is final by now (fitBounds may have moved it)

        if (asfHits.length) {
            // A point in the core zone decides the look of the banner: the
            // core zone's restrictions are the ones that actually stop a cache.
            const inCore = asfHits.some(function (h) { return h.zone === 'ydinalue'; });

            const where = asfHits.map(function (h) {
                return h.point.label +
                    ' (' + (h.zone === 'ydinalue' ? 'ydinalue' : 'tartuntavyöhyke') + ')';
            }).join(', ');

            const warn = document.createElement('div');
            warn.className = 'kp-asf-warn ' + (inCore ? 'kp-asf-core' : 'kp-asf-zone');
            warn.innerHTML =
                '<div class="kp-asf-head">' +
                (inCore
                    ? '⛔ SIKARUTON YDINALUE – tiukimmat rajoitukset'
                    : '⚠ SIKARUTON TARTUNTAVYÖHYKE') +
                '</div>' +
                '<div class="kp-asf-body">' +
                '<span class="kp-asf-where">' + where + '</span>' +
                '<ul>' +
                (inCore
                    ? '<li><b>Maastossa liikkuminen muutoin kuin teitä pitkin on ' +
                      'kielletty ydinalueella.</b></li>' +
                      '<li>Marjastus ja sienestys on kielletty ydinalueella.</li>'
                    : '') +
                '<li>Koirien ulkoiluttaminen muutoin kuin teitä pitkin kytkettynä on ' +
                'kielletty.</li>' +
                '<li>Yleisö- ja urheilutapahtumien järjestäminen maastossa on ' +
                'kielletty.</li>' +
                '</ul>' +
                '<span class="kp-asf-note">Rajaus on piirretty Ruokaviraston päätöksen ' +
                '(' + ASF_UPDATED + ') ja sen karttaliitteen pohjalta, eikä se ole ' +
                'virallinen paikkatieto. Tarkista aina ' +
                '<a target="_blank" href="' + ASF_MAP_URL + '">virallinen kartta</a> ja ' +
                '<a target="_blank" href="' + ASF_INFO_URL + '">Ruokaviraston ohjeet</a>.' +
                '</span>' +
                '</div>';

            mapDiv.parentNode.insertBefore(warn, mapDiv);
        }
    }

    // ---------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------
    function init() {
        addWaypointLinks();

        const onReviewPage = /\/admin\/review\.aspx/i.test(location.pathname);
        const hasCacheData = document.querySelector('#ctl00_ContentBody_CacheDataControl1_CacheData');
        if (!onReviewPage || !hasCacheData) return;

        // Offer to store a key once, if we don't have one yet.
        if (!apiKey && !GM_getValue(PROMPTED_STORE, false)) {
            const v = prompt(
                'Enter your MML API key to use Karttapaikka maps.\n' +
                '(Leave empty to use OpenStreetMap. You can set it later from the Tampermonkey menu.)', '');
            GM_setValue(PROMPTED_STORE, true);
            if (v && v.trim()) {
                apiKey = v.trim();
                GM_setValue(KEY_STORE, apiKey);
            }
        }

        buildMap();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
