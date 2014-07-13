/*global require,Cesium,L,URI,$,toGeoJSON,proj4,proj4_epsg,alert,confirm*/

"use strict";

var corsProxy = require('./corsProxy');
var TableDataSource = require('./TableDataSource');
var GeoData = require('./GeoData');
var readText = require('./readText');

var PopupMessage = require('./viewer/PopupMessage');

var defaultValue = Cesium.defaultValue;
var defined = Cesium.defined;
var DeveloperError = Cesium.DeveloperError;
var FeatureDetection = Cesium.FeatureDetection;
var KmlDataSource = Cesium.KmlDataSource;
var when = Cesium.when;

/**
* This class is loosely based on the cesium DataSource/DataSourceCollection
* model for feature data loading or converting to load each dataset as a
* GeoJsonDataCollection in Cesium or a GeoJson Layer in Leaflet.  
* 
* The WMS data, the url is passed to the Cesium and Leaflet WMS imagery layers.
*
* This also supports a TableDataSourceCollection which will be an addition to
* Cesium.
*
* @alias GeoDataCollection
* @internalConstructor
* @constructor
*/
var GeoDataCollection = function() {
    
    this.layers = [];
    
    var that = this;
    
    this.scene = undefined;
    this.map = undefined;
    
    //Init the dataSourceCollection
    this.dataSourceCollection = new Cesium.DataSourceCollection();
    
    this.GeoDataAdded = new Cesium.Event();
    this.GeoDataRemoved = new Cesium.Event();
    this.GeoDataReordered = new Cesium.Event();
    this.ViewerChanged = new Cesium.Event();
    this.ShareRequest = new Cesium.Event();

    // IE versions prior to 10 don't support CORS, so always use the proxy.
    this._alwaysUseProxy = (FeatureDetection.isInternetExplorer() && FeatureDetection.internetExplorerVersion()[0] < 10);
    
    //load list of available services for National Map
    this.services = [];

    this.csvs = [];
    this.CsvListChanged = new Cesium.Event();
};


/**
* Set the viewer to use with the geodata collection.
*
* @param {Object} options Object with the following properties:
* @param {Object} [options.scene] Set to Cesium Viewer scene object if Cesium Viewer.
* @param {Object} [options.map] Set to Leaflet map object if Leaflet Viewer.
*/
GeoDataCollection.prototype.setViewer = function(options) {
      //If A cesium scene present then this is in cesium globe
    this.scene = options.scene;
    this.map = options.map;

    if (this.scene) {
        this.imageryLayersCollection = this.scene.globe.imageryLayers;
    }
    this.ViewerChanged.raiseEvent(this, options);
    
    //re-request all the layers on the new map
    for (var i = 0; i < this.layers.length; i++) {
        this.layers[i].skip = true;
        this.sendLayerRequest(this.layers[i]);
    }
};


GeoDataCollection.prototype._getUniqueLayerName = function(name) {
    var base_name = name;
    var matches = true;
    var n = 1;
    while (matches) {
        matches = false;
        for (var i = 0; i < this.layers.length; i++) {
            if (this.layers[i].name === name) {
                matches = true;
            }
        }
        if (matches) {
            name = base_name + ' (' + n + ')';
            n++;
        }
    }
    return name;
};

function isFeatureLayer(collection, layer) {
    if (defined(layer.dataSource)) {
        return true;
    } else if (!collection.map) {
        return false;
    } else if (layer.primitive instanceof L.GeoJSON) {
        return true;
    }
}


function loadErrorResponse(err) {
    var msg = new PopupMessage({
        container : document.body,
        title : 'HTTP Error '+ err.statusCode,
        message : err.response
    });
}

GeoDataCollection.prototype.applyConstraints = function(constraints) {
    var color = Cesium.Color.fromCssColorString('yellow');
    color.alpha = 0.5;

    var dataSources = this.dataSourceCollection;
    for (var i = 0; i < dataSources.length; ++i) {
        var dataSource = dataSources.get(i);
        var dynamicObjects = dataSource.dynamicObjects.getObjects();

        var i;
        for (i = 0; i < dynamicObjects.length; ++i) {
            var dynamicObject = dynamicObjects[i];
            if (!dynamicObject.polygon) {
                continue;
            }

            var geoJson = dynamicObject.geoJson;

            var matches = true;
            for (var j = 0; j < constraints.length; ++j) {
                var constraint = constraints[j];
                var constraintKey = constraint.name;
                var constraintValue = geoJson.properties[constraintKey] | 0;
                matches &= constraintValue >= (constraint.minimum | 0) && constraintValue <= (constraint.maximum | 0);
            }

            if (matches) {
                dynamicObject.polygon.fill = new Cesium.ConstantProperty(true);
                dynamicObject.polygon.outline = new Cesium.ConstantProperty(true);
                var fillMaterial = new Cesium.ColorMaterialProperty();
                fillMaterial.color = new Cesium.ConstantProperty(color);
                dynamicObject.polygon.material = fillMaterial;

                if (dynamicObject.polyline) {
                    var colorMaterial = new Cesium.ColorMaterialProperty();
                    colorMaterial.color = new Cesium.ConstantProperty(color);
                    dynamicObject.polyline.show = new Cesium.ConstantProperty(true);
                    dynamicObject.polyline.material = colorMaterial;
                }
            } else {
                dynamicObject.polygon.fill = new Cesium.ConstantProperty(false);
                dynamicObject.polygon.outline = new Cesium.ConstantProperty(false);

                if (dynamicObject.polyline) {
                    var colorMaterial = new Cesium.ColorMaterialProperty();
                    colorMaterial.color = new Cesium.ConstantProperty(color);
                    dynamicObject.polyline.show = new Cesium.ConstantProperty(false);
                    dynamicObject.polyline.material = colorMaterial;
                }
            }
        }
    }
};

/**
* Add a new geodata item
*
* @param {Object} layer The layer to move.
*
* @returns {Object} The new layer added to the collection.
*/
GeoDataCollection.prototype.add = function(layer) {
    if (layer.skip) {
        layer.skip = false;
        return layer;
    }
    layer.name = this._getUniqueLayerName(layer.name);

    // Feature layers go on the bottom (which is the top in display order), then map layers go above that.
    var firstFeatureLayer = this.layers.length;
    for (var i = 0; i < this.layers.length; ++i) {
        if (isFeatureLayer(this, this.layers[i])) {
            firstFeatureLayer = i;
            break;
        }
    }

    if (isFeatureLayer(this, layer)) {
        this.layers.push(layer);
    } else {
        this.layers.splice(firstFeatureLayer, 0, layer);
    }

    // Force Leaflet to display the layers in the intended order.
    if (defined(this.map)) {
        for (var layerIndex = 0; layerIndex < this.layers.length; ++layerIndex) {
            var currentLayer = this.layers[layerIndex];
            if (defined(currentLayer.primitive)) {
                currentLayer.primitive.setZIndex(layerIndex + 100);
            }
        }
    }

    this.GeoDataAdded.raiseEvent(this, layer);
    return layer;
};

GeoDataCollection.prototype.isLayerMovable = function(layer) {
    return !isFeatureLayer(this, layer);
};

/**
 * Moves the given layer up so that it is displayed above the layers below it.
 * This effectively moves the layer later in the layers array.
 *
 * @param {Object} layer The layer to move.
 */
GeoDataCollection.prototype.moveUp = function(layer) {
    // Feature layers cannot be reordered.
    if (!this.isLayerMovable(layer)) {
        return;
    }

    var currentIndex = this.layers.indexOf(layer);
    var newIndex = currentIndex + 1;
    if (newIndex >= this.layers.length) {
        return;
    }

    var layerAbove = this.layers[newIndex];

    // We can't reorder past a feature layer.
    if (!this.isLayerMovable(layerAbove)) {
        return;
    }

    this.layers[currentIndex] = layerAbove;
    this.layers[newIndex] = layer;

    if (!defined(this.map)) {
        var layerIndex = this.imageryLayersCollection.indexOf(layer.primitive);
        var aboveIndex = this.imageryLayersCollection.indexOf(layerAbove.primitive);
        while (layerIndex !== -1 && aboveIndex !== -1 && aboveIndex > layerIndex) {
            this.imageryLayersCollection.raise(layer.primitive);
            layerIndex = this.imageryLayersCollection.indexOf(layer.primitive);
            aboveIndex = this.imageryLayersCollection.indexOf(layerAbove.primitive);
        }
    } else {
        for (var i = 0; i < this.layers.length; ++i) {
            var currentLayer = this.layers[i];
            if (defined(currentLayer.primitive)) {
                currentLayer.primitive.setZIndex(i + 100);
            }
        }
    }

    this.GeoDataReordered.raiseEvent(this);
};

/**
 * Moves the given layer down so that it is displayed under the layers above it.
 * This effectively moves the layer earlier in the layers array.
 *
 * @param {Object} layer The layer to move.
 */
GeoDataCollection.prototype.moveDown = function(layer) {
    // Feature layers cannot be reordered.
    if (!this.isLayerMovable(layer)) {
        return;
    }

    var currentIndex = this.layers.indexOf(layer);
    var newIndex = currentIndex - 1;
    if (newIndex < 0) {
        return;
    }

    var layerBelow = this.layers[newIndex];

    // We can't reorder past a feature layer.
    if (!this.isLayerMovable(layerBelow)) {
        return;
    }

    this.layers[currentIndex] = layerBelow;
    this.layers[newIndex] = layer;

    if (!defined(this.map)) {
        var layerIndex = this.imageryLayersCollection.indexOf(layer.primitive);
        var belowIndex = this.imageryLayersCollection.indexOf(layerBelow.primitive);
        while (layerIndex !== -1 && belowIndex !== -1 && belowIndex < layerIndex) {
            this.imageryLayersCollection.lower(layer.primitive);
            layerIndex = this.imageryLayersCollection.indexOf(layer.primitive);
            belowIndex = this.imageryLayersCollection.indexOf(layerBelow.primitive);
        }
    } else {
        for (var i = 0; i < this.layers.length; ++i) {
            var currentLayer = this.layers[i];
            if (defined(currentLayer.primitive)) {
                currentLayer.primitive.setZIndex(i + 100);
            }
        }
    }

    this.GeoDataReordered.raiseEvent(this);
};

/**
* Get a geodata item based on an id.
*
* @param {Integer} id id of the layer to return
*
* @returns {Object} A layer from the collection.
*/
GeoDataCollection.prototype.get = function(id) {
    return this.layers[id];
};

/**
* Remove a geodata item based on an id
*
* @param {Integer} id id of the layer to return
*/
GeoDataCollection.prototype.remove = function(id) {
    var layer = this.get(id);
    if (layer === undefined) {
        console.log('ERROR: layer not found:', id);
        return;
    }
    if (layer.dataSource) {
        if (this.dataSourceCollection.contains(layer.dataSource)) {
            this.dataSourceCollection.remove(layer.dataSource);
        }
        else {
            layer.dataSource.destroy();
        }
    }
    else if (this.map === undefined) {
        this.imageryLayersCollection.remove(layer.primitive);
    }
    else {
        this.map.removeLayer(layer.primitive);
    }
    
    this.layers.splice(id, 1);
    this.GeoDataRemoved.raiseEvent(this, layer);
};


/**
* Set whether to show a geodata item based on id
*
 * @param {Object} layer The layer to be processed.
 * @param {Boolean} val The setting of the show parameter.
*
*/
GeoDataCollection.prototype.show = function(layer, val) {
    if (layer === undefined) {
        console.log('ERROR: layer not found.');
        return;
    }
    layer.show = val;
    if (layer.dataSource) {
        if (val) {
            this.dataSourceCollection.add(layer.dataSource);
        }
        else {
            this.dataSourceCollection.remove(layer.dataSource, false);
        }
    }
    else {
        layer.primitive.show = val;
    }
};


// -------------------------------------------
// Services for GeoDataCollection
// -------------------------------------------
/**
 * Adds a set of services to the available GeodataCollection services.
 *
 * @param {Object} services An array of JSON service objects to add to the list.
 *
 */
GeoDataCollection.prototype.addServices = function(services) {
    if (services === undefined) {
        return;
    }

    for (var i = 0; i < services.length; i++) {
        console.log('added service for:', services[i].name);
        this.services.push(services[i]);
    }
};

/**
 * Returns an array of available services
 *
 * @returns {Array} an array of available services as JSON objects.
 */
GeoDataCollection.prototype.getServices = function() {
    return this.services;
};

// -------------------------------------------
// Handle loading and sharing visualizations
// -------------------------------------------
//stringify and remove cyclical links in the layers
GeoDataCollection.prototype._stringify = function() {
    var str_layers = [];
    for (var i = 0; i < this.layers.length; i++) {
        var layer = this.layers[i];
        var obj = {name: layer.name, type: layer.type, proxy:layer.proxy,
                   url: layer.url, extent: layer.extent};
        str_layers.push(obj);
    }
    return JSON.stringify(str_layers);
};

// Parse out the unstringified objects and turn them into Cesium objects
GeoDataCollection.prototype._parseObject = function(obj) {
    for (var p in obj) {
        if (p === 'west') {
            return new Cesium.Rectangle(obj.west, obj.south, obj.east, obj.north);
        }
        else if (p === 'red') {
            return new Cesium.Color(obj.red, obj.green, obj.blue, obj.alpha);
        }
        else if (typeof obj[p] === 'object') {
            obj[p] = this._parseObject(obj[p]);
        }
        else {
            return obj;
        }
    }
};

// Parse the string back into a layer collection
GeoDataCollection.prototype._parseLayers = function(str_layers) {
    var layers = JSON.parse(str_layers);
    var obj_layers = [];
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        for (var p in layer) {
            if (typeof layer[p] === 'object') {
                layer[p] = this._parseObject(layer[p]);
            }
        }
        obj_layers.push(layer);
    }
    return obj_layers;
};



/**
 * Loads a GeoDataCollection based on the intial url used to launch it
 *  supports the following query params on the url: data_url, vis_url, vis_str
 *
 * @param {Object} url The url to be processed.
 *
 */
GeoDataCollection.prototype.loadInitialUrl = function(url) {
    //URI suport for over-riding uriParams - put presets in uri_params
    var uri = new URI(url);
    var uri_params = {
        vis_url: undefined,
        vis_str: undefined,
        data_url: undefined
    };
    var overrides = uri.search(true);
    $.extend(uri_params, overrides);
    
    //store the current server location for use when creating urls
    this.visServer = uri.protocol() + '://' + uri.host();
    
        //TODO: Determine where this should live or if it should
    this.supportServer = 'http://geospace.research.nicta.com.au';

    var visUrl = uri_params.vis_url;
    var visStr = uri_params.vis_str;
    
    var dataUrl = uri_params.data_url;
    var dataFormat = uri_params.format;
    
    var that = this;
    
    //Initialize the view based on vis_id if passed in url
    if (visUrl) {
        //call to server to get json record
        Cesium.loadJson(visUrl).then( function(obj) {
                //capture an id if it is passed
            that.visID = obj.id;
            if (obj.camera !== undefined) {
                var e = JSON.parse(obj.camera);
                var camLayer = { name: 'Camera', extent: new Cesium.Rectangle(e.west, e.south, e.east, e.north)};
                that.zoomTo = true;
                that.GeoDataAdded.raiseEvent(that, camLayer);
            }
           
              //loop through layers adding each one
            var layers = that._parseLayers(obj.layers);
            for (var i = 0; i < layers.length; i++) {
                that.sendLayerRequest(layers[i]);
            }
        }, function(err) {
            loadErrorResponse(err);
        });
    }
    else if (visStr) {
        var obj = JSON.parse(visStr);
        that.visID = obj.id;
        if (obj.camera !== undefined) {
            var e = JSON.parse(obj.camera);
            var camLayer = { name: 'Camera', extent: new Cesium.Rectangle(e.west, e.south, e.east, e.north)};
            that.zoomTo = true;
            that.GeoDataAdded.raiseEvent(that, camLayer);
        }
       
          //loop through layers adding each one
        var layers = that._parseLayers(obj.layers);
        for (var i = 0; i < layers.length; i++) {
            that.sendLayerRequest(layers[i]);
        }
    }
    else if (dataUrl) {
        dataUrl = decodeURIComponent(dataUrl);
        that.loadUrl(dataUrl, dataFormat);
    }
};

/**
 * Loads a data file based on the  url
 *
 * @param {Object} url The url to be processed.
 *
 */
GeoDataCollection.prototype.loadUrl = function(url, format) {
    var that = this;
    if (format || that.formatSupported(url)) {
        if (format === undefined) {
            format = getFormatFromUrl(url);
        }
        if (format === 'KMZ') {
            Cesium.loadBlob(url).then( function(blob) {
                blob.name = url;
                that.addFile(blob);
            }, function(err) {
                loadErrorResponse(err);
            });
        } else {
            Cesium.loadText(url).then(function (text) { 
                that.zoomTo = true;
                that.loadText(text, url, format);
            }, function(err) {
                loadErrorResponse(err);
            });
        }
    }
};


/**
* Package up a share request and send an event
*
* @param {Object} options Object with the following properties:
* @param {Object} [options.image] An image dataUrl with the current view.
* @param {Object} [options.camera] Current camera settings (just extent for now)
*/
GeoDataCollection.prototype.setShareRequest = function(options) {
    var request = this.getShareRequest(options);
    this.ShareRequest.raiseEvent(this, request);
};


/**
* Get a share request object based on the description passed
*
* @param {Object} description Object with the following properties:
* @param {Object} [description.image] An image dataUrl with the current view.
* @param {Object} [description.camera] Current camera settings (just extent for now)
*
* @returns {Object} A request object
*
*/
GeoDataCollection.prototype.getShareRequest = function( description ) {
    var request = {};
    
    //TODO: bundle up datesets for smaller drag and drop data
    request.layers = this._stringify();
    request.version = '0.0.02';
    request.camera = JSON.stringify(description.camera); //just extent for now
    if (this.visID) {
        request.id = this.visID;
    }
    request.image = description.image;
    return request;
};


/**
* Given a share request object, turn it into a valid url to launch in viewer
*
* @param {Object} request Object containing the share request
*
* @returns {Url} A url that will launch in the viewer
*/
GeoDataCollection.prototype.getShareRequestURL = function( request ) {
    var img = request.image;
    request.image = undefined;
    var requestStr = JSON.stringify(request);
    var url = this.visServer + '?vis_str=' + encodeURIComponent(requestStr);
    request.image = img;
    return url;
};


// -------------------------------------------
// Handle data sources from text
// -------------------------------------------
// Derive a format from a url
function getFormatFromUrl(url) {
    if (url === undefined) {
        return;
    }
        //try to parse as url and get format
    var uri = new URI(url);
    var params = uri.search(true);
    if (params.outputFormat || params.f) {
        var str = params.outputFormat || params.f;
        return str.toUpperCase();
    }
        //try to get from extension
    var idx = url.lastIndexOf('.');
    if (idx !== -1 && (idx > url.lastIndexOf('/'))) {
        return url.toUpperCase().substring(idx+1);
    }
}

/**
* Determine if a data format is natively supported based on the format derived from the srcname
*
* @param {String} srcname Name of data file
*
* @returns {Boolean} true if supported natively, false otherwise
*/
GeoDataCollection.prototype.formatSupported = function(srcname) {
    var supported = ["CZML", "GEOJSON", "GJSON", "TOPOJSON", "JSON", "TOPOJSON", "KML", "KMZ", "GPX", "CSV"];
    var format = getFormatFromUrl(srcname);
    
    for (var i = 0; i < supported.length; i++) {
        if (format === supported[i]) {
            return true;
        }
    }
    return false;
};

/**
* Load text as a geodata item
*
 * @param {String} text The text to be processed.
 * @param {String} srcname The text file name to get the format extension from.
 * @param {String} [format] Format override for dataset
 * @param {Object} [layer] Layer object if that already exists.
*
* @returns {Boolean} true if processed
*/
GeoDataCollection.prototype.loadText = function(text, srcname, format, layer) {
    var DataSource;
    
    var dom;
    
    if (layer === undefined) {
        layer = new GeoData({ name: srcname, type: 'DATA' });
    }
    if (format === undefined) {
        format = getFormatFromUrl(srcname);
    }
    format = format.toUpperCase();

    var that = this;
    
    //TODO: Save dataset text for dnd data

        //Natively handled data sources in cesium
    if (format === "CZML") {
        var czmlDataSource = new Cesium.CzmlDataSource();
        czmlDataSource.load(JSON.parse(text));
        this.dataSourceCollection.add(czmlDataSource);
            //add it as a layer
        layer.dataSource = czmlDataSource;
        layer.extent = getDataSourceExtent(czmlDataSource);
        this.add(layer);
    }
    else if (format === "GEOJSON" ||
            format === "GJSON" ||
            format === "JSON" ||
            format === "TOPOJSON") {
        this.addGeoJsonLayer(JSON.parse(text), layer);
    } 
        //Convert in browser using toGeoJSON https://github.com/mapbox/togeojson    
    else if (format === "KML") {
        layer = new GeoData({ name: srcname, type: 'DATA' });
        dom = (new DOMParser()).parseFromString(text, 'text/xml');    
        this.addGeoJsonLayer(toGeoJSON.kml(dom), layer);
    } 
    else if (format === "GPX") {
        dom = (new DOMParser()).parseFromString(text, 'text/xml');    
        this.addGeoJsonLayer(toGeoJSON.gpx(dom), layer);
    } 
        //Handle table data using TableDataSource plugin        
    else if (format === "CSV") {
        //load csv data
        var jsonTable = $.csv.toArrays(text);
        that.csvs.push(jsonTable);
        applyCsvToFeatures(that, jsonTable);

        this.CsvListChanged.raiseEvent(this)

        // var tableDataSource = new TableDataSource();
        // tableDataSource.loadText(text);
        // this.dataSourceCollection.add(tableDataSource);
        
        // layer.dataSource = tableDataSource;
        // layer.extent = tableDataSource.dataset.getExtent();
        // this.add(layer);
    }
        //Return false so widget can try to send to conversion service
    else {
        console.log('There is no handler for this file based on its extension : ' + srcname);
        return false;
    }
    return true;
};

function applyCsvToFeatures(geoDataCollection, csv) {
    var dataSources = geoDataCollection.dataSourceCollection;
    for (var i = 0; i < dataSources.length; ++i) {
        var dataSource = dataSources.get(i);
        var objects = dataSource.dynamicObjects.getObjects();
        correlate_geojson_csv(dataSource, objects, csv);
    }
}

// -------------------------------------------
// Convert OGC Data Sources to GeoJSON
// -------------------------------------------
//Function to intercept and fix up ESRI REST Json to GeoJSON
//TODO: multipoint, multipolyline, multipolygon
function _EsriRestJson2GeoJson(obj) {
    if (obj.geometryType === undefined || obj.features === undefined || obj.type === 'FeatureCollection') {
        return obj;
    }

    var pts;
    var geom;

    obj.type = "FeatureCollection";
    obj.crs = {"type":"EPSG","properties":{"code":"4326"}};
    for (var i = 0; i < obj.features.length; i++) {
        var feature = obj.features[i];
        feature.type = "Feature";
        feature.properties = feature.attributes;
        if (obj.geometryType === "esriGeometryPoint") {
            pts = [feature.geometry.x, feature.geometry.y ];
            geom = { "type": "Point", "coordinates": pts };
            feature.geometry = geom;
        }
        else if (obj.geometryType === "esriGeometryPolyline") {
            pts = feature.geometry.paths[0];
            geom = { "type": "LineString", "coordinates": pts };
            feature.geometry = geom;
        }
        else if (obj.geometryType === "esriGeometryPolygon") {
            pts = feature.geometry.paths[0];
            geom = { "type": "Polygon", "coordinates": pts };
            feature.geometry = geom;
        }
    }
    return obj;
}

//Utility function to change esri gml positions to geojson positions
function _gml2coord(posList) {
    var pnts = posList.split(/[ ,]+/);
    var coords = [];
    for (var i = 0; i < pnts.length; i+=2) {
        coords.push([parseFloat(pnts[i+1]), parseFloat(pnts[i])]);
    }
    return coords;
}

//Utility function to convert esri gml based feature to geojson
function _convertFeature(feature, geom_type) {
    var newFeature = {type: "Feature"};
    var pts = (geom_type === 'Point') ? _gml2coord(feature.pos)[0] : _gml2coord(feature.posList);
    newFeature.geometry = { "type": geom_type, "coordinates": pts };
    return newFeature;
}           
            
            
//Utility function to convert esri gml to geojson
function _EsriGml2GeoJson(obj) {
    var newObj = {type: "FeatureCollection", crs: {"type":"EPSG","properties":{"code":"4326"}}, features: []};

    function pointFilterFunction(obj, prop) {
        newObj.features.push(_convertFeature(obj[prop], 'Point'));
    }

    function lineStringFilterFunction(obj, prop) {
        newObj.features.push(_convertFeature(obj[prop], 'LineString'));
    }

    function polygonFilterFunction(obj, prop) {
        newObj.features.push(_convertFeature(obj[prop], 'Polygon'));
    }

    for (var i = 0; i < obj.featureMember.length; i++) {
           //TODO: get feature properties from non-SHAPE properties if present
        //feature.properties = feature.attributes;

        //Recursively find features and add to FeatureCollection
        filterValue(obj.featureMember[i], 'Point', pointFilterFunction);
        filterValue(obj.featureMember[i], 'LineString', lineStringFilterFunction);
        filterValue(obj.featureMember[i], 'Polygon', polygonFilterFunction);
    }
    return newObj;
}


// Filter a geojson coordinates array structure
var filterArray = function (pts, func) {
    if (!(pts[0] instanceof Array) || !((pts[0][0]) instanceof Array) ) {
        pts = func(pts);
        return pts;
    }
    for (var i = 0; i < pts.length; i++) {
        pts[i] = filterArray(pts[i], func);  //at array of arrays of points
    }
    return pts;
};

// find a member by name in the gml
function filterValue(obj, prop, func) {
    for (var p in obj) {
        if (obj.hasOwnProperty(p) === false) {
            continue;
        }
        else if (p === prop) {
            if (func && (typeof func === 'function')) {
                (func)(obj, prop);
            }
        }
        else if (typeof obj[p] === 'object') {
            filterValue(obj[p], prop, func);
        }
    }
}

function correlate_geojson_csv(dataSource, dynamicObjects, jsonTable) {
    var decileColors = [
        undefined,
        '#990000',
        '#CC0000',
        '#FF0000',
        '#FF9900',
        '#FFCC66',
        '#CCFFFF',
        '#99CCCC',
        '#0099CC',
        '#006699',
        '#003399'
    ];

    var field = jsonTable[0][0];
    var title = jsonTable[0][1];

    var idMap = {};

    var i;
    for (i = 1; i < jsonTable.length; ++i) {
        idMap[jsonTable[i][0]] = jsonTable[i][1];
    }

    for (i = 0; i < dynamicObjects.length; ++i) {
        var dynamicObject = dynamicObjects[i];
        var geoJson = dynamicObject.geoJson;

        var value = idMap[geoJson.properties[field] | 0];
        if (defined(value)) {
            geoJson.properties[title] = value;

            if (dataSource) {
                dataSource.refreshDescription(dynamicObject);
            }

            var propertyName = title;

            // TODO: convert value to decile if necessary
            if (!(value > 0 && value <= 10)) {
                continue;
            }

            var color = Cesium.Color.fromCssColorString(decileColors[value]);
            color.alpha = 0.5;

            //object.polygon.fill = new ConstantProperty(Color.fromCssColorString(decileColors[decile]));
            if (dynamicObject.polygon) {
                dynamicObject.polygon.outline = new Cesium.ConstantProperty(true);
                dynamicObject.polygon.outlineColor = new Cesium.ConstantProperty(color);
                dynamicObject.polygon.fill = new Cesium.ConstantProperty(true);
                dynamicObject.polygon.fillColor = new Cesium.ConstantProperty(color);

                var fillMaterial = new Cesium.ColorMaterialProperty();
                fillMaterial.color = new Cesium.ConstantProperty(color);
                dynamicObject.polygon.material = fillMaterial;
            } else {
                console.log('no polygon for ' + geoJson.properties.POA_CODE);
            }

            if (dynamicObject.polyline) {
                var colorMaterial = new Cesium.ColorMaterialProperty();
                colorMaterial.color = new Cesium.ConstantProperty(color);
                dynamicObject.polyline.material = colorMaterial;
            }
        }
    }
}

// -------------------------------------------
// Connect to OGC Data Sources
// -------------------------------------------
GeoDataCollection.prototype._viewFeature = function(request, layer) {
    var that = this;
    
    if (layer.proxy || this.shouldUseProxy(request)) {
        request = corsProxy.getURL(request);
    }

    Cesium.loadText(request).then( function (text) {
        //convert to geojson
        var obj;
        if (text[0] === '{') {
            obj = JSON.parse(text);
            obj = _EsriRestJson2GeoJson(obj);  //ESRI Rest
        }
        else {
            obj = $.xml2json(text);         //ESRI WFS
            if (obj.Exception !== undefined) {
                console.log('Exception returned by the WFS Server:', obj.Exception.ExceptionText);
            }
            obj = _EsriGml2GeoJson(obj);
                //Hack for gazetteer since the coordinates are flipped
            if (text.indexOf('gazetter') !== -1) {
                for (var i = 0; i < obj.features.length; i++) {
                    var pt = obj.features[i].geometry.coordinates; 
                    var t = pt[0]; pt[0] = pt[1]; pt[1] = t;
                 }
            }
        }
        if (layer.csv_url !== undefined && that.map === undefined) {
            //load csv data
            console.log(layer.csv_url);
            Cesium.loadText(layer.csv_url).then( function (text) {
                var jsonTable = $.csv.toArrays(text);
                correlate_geojson_csv(undefined, obj, jsonTable);
                that.addGeoJsonLayer(obj, layer);
            }, function(err) {
                loadErrorResponse(err);
            });
        }
        else {
            that.addGeoJsonLayer(obj, layer);
        }
    }, function(err) {
        loadErrorResponse(err);
    });
};


// Show wms map
GeoDataCollection.prototype._viewMap = function(request, layer) {
    var uri = new URI(request);
    var params = uri.search(true);
    var layerName = params.layers;

    var provider;
    var proxy;

    if (this.map === undefined) {
        var wmsServer = request.substring(0, request.indexOf('?'));
        var url = 'http://' + uri.hostname() + uri.path();
        if (layer.proxy || this.shouldUseProxy(url)) {
            if (layer.description && layer.description.username && layer.description.password) {
                proxy = corsProxy.withCredentials(layer.description.username, layer.description.password);
            } else {
                proxy = corsProxy;
            }
        }

        if (layerName === 'REST') {
            provider = new Cesium.ArcGisMapServerImageryProvider({
                url: url,
                proxy: proxy
            });
        }
        else {
            provider = new Cesium.WebMapServiceImageryProvider({
                url: url,
                layers : encodeURIComponent(layerName),
                parameters: {
                    'format':'image/png',
                    'transparent':'true',
                    'styles': ''
                },
                proxy: proxy
            });
        }
        layer.primitive = this.imageryLayersCollection.addImageryProvider(provider);
    }
    else {
        var server = request.substring(0, request.indexOf('?'));
        if (layer.proxy || this.shouldUseProxy(server)) {
           server = corsProxy.getURL(server);
        }
        
        if (layerName === 'REST') {
            provider = new L.esri.TiledMapLayer(server);
        }
        else {
            provider = new L.tileLayer.wms(server, {
                layers: layerName,
                format: 'image/png',
                transparent: true
            });
        }
        layer.primitive = provider;
        this.map.addLayer(provider);
    }

    this.add(layer);
};

// Show csv table data
GeoDataCollection.prototype._viewTable = function(request, layer) {
    var that = this;
        //load text here to let me control functions called after
    Cesium.loadText(request).then( function (text) {
        var tableDataSource = new TableDataSource();
        tableDataSource.loadText(text);
        if (that.map === undefined) {
            that.dataSourceCollection.add(tableDataSource);
            layer.dataSource = tableDataSource;
            that.add(layer);
        }
        else {
            var pointList = tableDataSource.dataset.getPointList();
            var dispPoints = [];
            for (var i = 0; i < pointList.length; i++) {
                dispPoints.push({ type: 'Point', coordinates: pointList[i].pos});
            }
            that.addGeoJsonLayer(dispPoints, layer);
        }
    }, function(err) {
        loadErrorResponse(err);
    });
};

// Load data file based on extension if loaded as DATA layer
GeoDataCollection.prototype._viewData = function(request, layer) {
    var that = this;
    var format = getFormatFromUrl(layer.url);
    
        //load text here to let me control functions called after
    Cesium.loadText(request).then (function (text) {
        that.loadText(text, layer.name, format, layer);
    }, function(err) {
        loadErrorResponse(err);
    });
};

/**
* Determine if a data format is natively supported based on the format derived from the srcname
*
* @param {Object} layer The layer object to make into a visible layer.
*
*/
GeoDataCollection.prototype.sendLayerRequest = function(layer) {
    var request = layer.url;
//    console.log('LAYER REQUEST:',request);
    
    // Deal with the different data Services
    if (layer.type === 'WFS' || layer.type === 'REST' || layer.type === 'GME') {
        this._viewFeature(request, layer);
    }
    else if (layer.type === 'WMS') {
        this._viewMap(request, layer);
    }
    else if (layer.type === 'DATA') {
        this._viewData(request, layer);
    }
//    if (layer.type === 'CKAN') {
//        this._viewFeature(request, layer);
//    }
    else {
        throw new DeveloperError('Creating layer for unsupported service: '+layer.type);
    }
};


/**
* Build a query to get feature from service
*
* @param {Object} description Object with the following properties:
* @param {String} description.Name Name of feature.
* @param {Url} description.base_url The url for the service
* @param {String} description.type The identifier of the service
* @param {String} [description.version] The version of the service to use
* @param {String} [description.esri] If this is an ESRI OGC service
* @param {Integer} [description.count] Maximum number of features to return
* @param {Object} [description.extent] Extent filter for feature request
*/
GeoDataCollection.prototype.getOGCFeatureURL = function(description) {
    console.log('Getting ', description.Name);
    
    var request = description.base_url;
    var name  = encodeURIComponent(description.Name);
    if (description.type === 'WMS') {
        request += '?service=wms&request=GetMap&layers=' + name;
        return request;
    }
    else if (description.type === 'WFS') {
        description.version = 1.1;
        request += '?service=wfs&request=GetFeature&typeName=' + name + '&version=' + description.version + '&srsName=EPSG:4326';
        
        if (description.esri === undefined) {
            request += '&outputFormat=JSON';
        }
        if (description.count) {
            request += '&maxFeatures=' + description.count;
        }
    }
    else if (description.type === 'REST') {
        request += '/' + description.name;
        request += '/query?geometryType=esriGeometryEnvelope&inSR=&spatialRel=esriSpatialRelIntersects&returnGeometry=true&f=pjson';
    }
//    else if (description.type === 'CKAN') {
//        for (var i = 0; i < description.resources.length; i++) {
//            var format = description.resources[i].format.toUpperCase();
//            if (format === 'GEOJSON' || format === 'JSON' || format === 'KML') {
//                request = description.resources[i].url;
//                break;
//            }
//        }
//        return request;
//    }
    else {
//        throw new Cesium.DeveloperError('Getting feature for unsupported service: '+description.type);
    }
    
    if (description.extent) {
        var ext = description.extent;
        var pos = [ Cesium.Math.toDegrees(ext.west), Cesium.Math.toDegrees(ext.south), 
                    Cesium.Math.toDegrees(ext.east), Cesium.Math.toDegrees(ext.north)];
        //crazy ogc bbox rules - first is old lon/lat ordering, second is newer lat/lon ordering
        var version = parseFloat(description.version);
        if (description.type === 'WFS' && version < 1.1) {
            request = request + '&bbox='+pos[0]+','+pos[1]+','+pos[2]+','+pos[3];
        }
        else if (description.type === 'REST') {
            request = request + '&geometry='+pos[0]+','+pos[1]+','+pos[2]+','+pos[3];
        }
        else {
            request = request + '&bbox='+pos[1]+','+pos[0]+','+pos[3]+','+pos[2]+',urn:x-ogc:def:crs:EPSG:6.9:4326';
        }
    }
    
    return request;
};


//Utility function to derive a collection from a service
function _getCollectionFromServiceLayers(layers, description) {
    var obj = {"name":"Data Sets", "Layer": []};
    for (var i = 0; i < layers.length; i++) {
        var layer = layers[i];
        var name = layer.Name;
        var idx = name.indexOf(':');
        var topic_name = name.substring(0, idx);
        var topic; // = undefined;
        for (var j = 0; j < obj.Layer.length; j++) {
            if (obj.Layer[j].name === topic_name) {
                topic = obj.Layer[j];
                break;
            }
        } 
        if (topic === undefined) {
            topic = {
                name: topic_name, 
                base_url: description.base_url,
                proxy: false,
                type: description.type,
                queryable: 0,
                Layer: []
            };
            obj.Layer.push(topic);
        }
        var dataset = {
            Name: name.substring(idx+1), 
            Title: name.substring(idx+1), 
            BoundingBox: {
                west: layer.EX_GeographicBoundingBox.westBoundLongitude,
                east: layer.EX_GeographicBoundingBox.eastBoundLongitude,
                south: layer.EX_GeographicBoundingBox.southBoundLatitude,
                north: layer.EX_GeographicBoundingBox.northBoundLatitude                
            },
            queryable: 1
        };
        topic.Layer.push(dataset);
    }
    var collection = {"name":"Data Collection", "Layer": [ obj ] };
    console.log(JSON.stringify(collection));
}

//Utility function to flatten layer hierarchy
function _recurseLayerList(layer_src, layers) {
    if (!(layer_src instanceof Array)) {
        layer_src = [layer_src];
    }
    for (var i = 0; i < layer_src.length; i++) {
        if (layer_src[i].Layer) {
            if (layer_src[i].queryable === 1) {
                layers.push(layer_src[i]);
            }
            _recurseLayerList(layer_src[i].Layer, layers);
        }
        else {
            layers.push(layer_src[i]);
        }
    }
}

/**
* Parse through capabilities to get possible layers
*
* @param {String} text The text returned from the Capabilities request.
* @param {Object} description Object with the following properties:
* @param {String} description.Name Name of feature.
* @param {Url} description.base_url The url for the service
* @param {String} description.type The identifier of the service
* @param {String} [description.version] The version of the service to use
* @param {String} [description.esri] If this is an ESRI OGC service
* @param {Integer} [description.count] Maximum number of features to return
* @param {Object} [description.extent] Extent filter for feature request
*
* @returns {Array} An array of layer descripters from the service
*/
GeoDataCollection.prototype.handleCapabilitiesRequest = function(text, description) {
    var json_gml;
    if (text[0] === '{') {
        json_gml = JSON.parse(text);
    }
    else {
        json_gml = $.xml2json(text);
    }
    
    //find the array of available layers
    var i;
    var layers = [];
    if (description.type === 'WFS') {
        layers = json_gml.FeatureTypeList.FeatureType;
        if (!(layers instanceof Array)) {
            layers = [layers];
        }

        // If the data source name is just its URL, and we have a better title from GetCapabilities, use it.
        var title;
        if (json_gml.ServiceIdentification !== undefined) {
            title = json_gml.ServiceIdentification.Title;
        }
        else if (json_gml.Service !== undefined) { //wfs 1.0
            title = json_gml.Service.Title;
        }
        if (title && description.name === description.base_url) {
            description.name = title;
        }
        
        if (json_gml.Esri !== undefined || layers[0].OutputFormats !== undefined) {
            description.esri = true;
        }
    }
    else if (description.type === 'WMS') {
        var layer_src = [json_gml.Capability.Layer];
        _recurseLayerList(layer_src, layers);
//        _getCollectionFromServiceLayers(layers, description)
    }
    else if (description.type === 'REST') {
        var layer = json_gml.layers;
        for (i = 0; i < layer.length; i++) {
            if (layer[i].subLayerIds instanceof Array) {
                continue;
            }
            layer[i].Title = layer[i].name;
            layer[i].name = layer[i].id;
            layers.push(layer[i]);
        }
        var ext = json_gml.fullExtent;
        description.extent = Cesium.Rectangle.fromDegrees(parseFloat(ext.xmin), parseFloat(ext.ymin), 
            parseFloat(ext.xmax), parseFloat(ext.ymax));
    }
//    else if (description.type === 'CKAN') {
//        layers = json_gml.result.results;
//        for (i = 0; i < layers.length; i++) {
//            layers[i].Name = layers[i].name;
//        }
 //   }
    else {
        throw new DeveloperError('Somehow got capabilities from unsupported type: ' + description.type);
    }
    
    //get the version
    if (json_gml.ServiceIdentification) {
        description.version = parseFloat(json_gml.ServiceIdentification.ServiceTypeVersion);
    }
    else if (json_gml.Service) {
        description.version = parseFloat(json_gml.version);
    }
    
    description.Layer = layers;
};

/**
* Get capabilities from service for WMS, WFS and REST
*  This also include GME and ESRI backends via their version of WMS/WFS
*
* @param {Object} description Object with the following properties:
* @param {Url} description.base_url The url for the service
* @param {String} description.type The identifier of the service
* @param {Boolean} description.proxy True if a proxy is necessary
* @param {String} description.username Username for password authenticated services
* @param {String} description.password Password for password authenticated services
* @param {Function} callback Function to carry out at the successful completion of the request
*/
GeoDataCollection.prototype.getCapabilities = function(description, callback) {
    var request;
    if (description.type === 'REST') {
        request = description.base_url + '?f=pjson';
    }
//    else if (description.type === 'CKAN') {
//        request = description.base_url + '/api/3/action/package_search?q=GeoJSON&rows=50';
//    }
    else if (description.type === 'WMS' || description.type === 'WFS') {
        request = description.base_url + '?service=' + description.type + '&request=GetCapabilities';
    }
    else {
        throw new DeveloperError('Cannot get capabilites for service: ' + description.type);
    }
   
    console.log('CAPABILITIES REQUEST:',request);
    if (description.proxy || this.shouldUseProxy(request)) {
        request = corsProxy.getURL(request);
    }

    var that = this;
    Cesium.loadText(request, undefined, description.username, description.password).then ( function(text) {
        that.handleCapabilitiesRequest(text, description);
        callback(description);
    }, function(err) {
        loadErrorResponse(err);
    });
};


// ----------------
// Add geojson
// ----------------

/**
* Get the geographic extent of a datasource
*
* @param {Object} dataSource Cesium.dataSource object
*
* @returns {Object} A Cesium.extent object bounding the data points
*/
function getDataSourceExtent(dataSource) {
    var collection = dataSource.dynamicObjects;
    var objects = collection.getObjects();
    var e0;
    
    var julianDate = new Cesium.JulianDate();

    var cArray;

    for (var i = 0; i < objects.length; i++) {
        if (objects[i].vertexPositions) {
            cArray = objects[i].vertexPositions.getValue(julianDate);
        }
        else if (objects[i].position) {
            cArray = [objects[i].position.getValue(julianDate)];
        }
        else {
            continue;
        }
        var cartArray = Cesium.Ellipsoid.WGS84.cartesianArrayToCartographicArray(cArray);
        var e1 = Cesium.Rectangle.fromCartographicArray(cartArray);
        if (e0 === undefined) {
            e0 = e1;
        }
        else {
            var west = Math.min(e0.west, e1.west);
            var south = Math.min(e0.south, e1.south);
            var east = Math.max(e0.east, e1.east);
            var north = Math.max(e0.north, e1.north);
            e0 = new Cesium.Rectangle(west, south, east, north);
        }
    }
    return e0;
}



// -------------------------------------------
// Reproject geojson to WGS84
// -------------------------------------------

/*
//function for GeoJSONDataSource to reproject coords
function myCrsFunction(coordinates, id) {
    var source = new proj4.Proj(proj4_epsg[id]);
    var dest = new proj4.Proj('EPSG:4326');
    var p = new proj4.Point(coordinates[0], coordinates[1]);
    proj4(source, dest, p);      //do the transformation.  x and y are modified in place
    var cartographic = Cesium.Cartographic.fromDegrees(p.x, p.y);
    return Cesium.Ellipsoid.WGS84.cartographicToCartesian(cartographic);
}

// Create a reproject func for GeoJsonDataSource to use
function createCesiumReprojectFunc(proj) {
    return function(coordinates) {
        return myCrsFunction(coordinates, proj);
    };
}

// if we want cesium GeoJsonDataSource to do it
function setCesiumReprojectFunc(code) {   
    Cesium.GeoJsonDataSource.crsNames[code] = createCesiumReprojectFunc(code);
}
*/

// Function to pass to reproject function
function pntReproject(coordinates, id) {
    var source = new proj4.Proj(proj4_epsg[id]);
    var dest = new proj4.Proj('EPSG:4326');
    var p = new proj4.Point(coordinates[0], coordinates[1]);
    proj4(source, dest, p);      //do the transformation.  x and y are modified in place
    return [p.x, p.y];
}


// Get the crs code from the geojson
function getCrsCode(gjson_obj) {
    if (gjson_obj.crs === undefined || gjson_obj.crs.type !== 'EPSG') {
        return "";
    }
    var code = gjson_obj.crs.properties.code;
    if (code === '4283') {
        code = '4326';
    }
    return gjson_obj.crs.type + ':' + code;
}

//  TODO: get new proj4 strings from REST service
//  requires asynchronous layer loading so on hold for now
function addProj4Text(code) {
        //try to get from a service
    var url = 'http://spatialreference.org/ref/epsg/'+code.substring(5)+'/proj4/';
    Cesium.loadText(url).then(function (proj4Text) {
        console.log('Adding new string for ', code, ': ', proj4Text, ' before loading datasource');
        proj4_epsg[code] = proj4Text;
    }, function(err) {
        loadErrorResponse(err);
    });
}

// Set the Cesium Reproject func if not already set - return false if can't set
function supportedProjection(code) {
    return proj4_epsg.hasOwnProperty(code);
}

// Reproject a point list based on the supplied crs code
function reprojectPointList(pts, code) {
    if (!(pts[0] instanceof Array)) {
        return pntReproject(pts, code);  //point
    }
    var pts_out = [];
    for (var i = 0; i < pts.length; i++) {
        pts_out.push(pntReproject(pts[i], code));
    }
    return pts_out;
}

// Reproject a GeoJson based on the supplied crs code
function reprojectGeoJSON(obj, crs_code) {
    filterValue(obj, 'coordinates', function(obj, prop) { obj[prop] = filterArray(obj[prop], function(pts) {
            return reprojectPointList(pts, crs_code);
        });
    });
    obj.crs.properties.code = '4326';
}

// Reduce the resolution of a point list in degrees
function reducePointList(pts, epsilon, limit) {
    if (!(pts[0] instanceof Array)) {
        return pts;  //point
    }
    if (pts.length < 50) {
        return pts;
    }
    //reduce points in polyline using a simple greedy algorithm
    var pts_out = [];
    var skip_cnt;
    for (var v = 0; v < pts.length; v += skip_cnt) {
        pts_out.push(pts[v]);
         //keep skipping until something further away then epsilon or limit points removed
        for (skip_cnt = 1; skip_cnt < limit; skip_cnt++) {
            if (v + skip_cnt >= pts.length) {
                break;
            }
            if ((Math.abs(pts[v][0] - pts[v + skip_cnt][0]) + Math.abs(pts[v ][1] - pts[v + skip_cnt][1])) > epsilon) {
                break;
            }
        }
    }
    return pts_out;
}

// Filter a geojson coordinates array structure
var countPnts = function (pts, cnt) {
    if (!(pts[0] instanceof Array) ) {
        cnt.tot++;
    }
    else if (!((pts[0][0]) instanceof Array) ) {
        cnt.tot += pts.length;
        if (pts.length > cnt.longest) {
            cnt.longest = pts.length;
        }
    }
    else {
        for (var i = 0; i < pts.length; i++) {
            countPnts(pts[i], cnt);  //at array of arrays of points
        }
    }
};

//Lazy function to downsample GeoJson
function _downsampleGeoJSON(obj) {
    var obj_size = JSON.stringify(obj).length;
    var cnt = {tot:0, longest:0};
    filterValue(obj, 'coordinates', function(obj, prop) { countPnts(obj[prop], cnt); });
    if (cnt.longest < 50 || cnt.tot < 10000) {
        console.log('Skipping downsampling');
        return;
    }
    filterValue(obj, 'coordinates', function(obj, prop) { obj[prop] = filterArray(obj[prop], function(pts) {
        return reducePointList(pts, 0.005, 10);
    }); });
    console.log('downsampled object from', obj_size, 'bytes to', JSON.stringify(obj).length);
}


var line_palette = {
    minimumRed : 0.4,
    minimumGreen : 0.4,
    minimumBlue : 0.4,
    maximumRed : 0.9,
    maximumGreen : 0.9,
    maximumBlue : 0.9,
    alpha : 1.0
};
var point_palette = {
    minimumRed : 0.6,
    minimumGreen : 0.6,
    minimumBlue : 0.6,
    maximumRed : 1.0,
    maximumGreen : 1.0,
    maximumBlue : 1.0,
    alpha : 1.0
};


//Get a random color for the data based on the passed seed (usually dataset name)
function getRandomColor(palette, seed) {
    if (seed !== undefined) {
        if (typeof seed === 'string') {
            var val = 0;
            for (var i = 0; i < seed.length; i++) {
                val += seed.charCodeAt(i);
            }
            seed = val;
        }
        Cesium.Math.setRandomNumberSeed(seed);
    }
    return Cesium.Color.fromRandom(palette);
}

//Convert a color object into Cesium.Color object
function getCesiumColor(clr) {
    if (clr instanceof Cesium.Color) {
        return clr;
    }
    return new Cesium.Color(clr.red, clr.green, clr.blue, clr.alpha);
}




/**
* Add a GeoJson object as a geodata datasource layer
*
 * @param {Object} geojson The GeoJson object to add
 * @param {Object} [layer] The layer to add if it already exists
*
 * @returns {Object} layer The layer that wa added
*/
GeoDataCollection.prototype.addGeoJsonLayer = function(geojson, layer) {
    //set default layer styles
    if (layer.style === undefined) {
        layer.style = {line: {}, point: {}, polygon: {}};
        layer.style.line.color = Cesium.Color.fromCssColorString('blue');//getRandomColor(line_palette, layer.name);
        layer.style.line.width = 2;
        layer.style.point.color = getRandomColor(point_palette, layer.name);
        layer.style.point.size = 10;
        layer.style.polygon.color = layer.style.line.color;
        layer.style.polygon.fill = false;  //off by default for perf reasons
        layer.style.polygon.fillcolor = layer.style.line.color;
        layer.style.polygon.fillcolor.alpha = 0.75;
    }
    
    /*var style = [
        '#world {', 
            'line-width: 2;', 
            'line-color: #f00;', 
            '[frame-offset = 1] {', 
                'line-width: 3;', 
            '}', 
            '[frame-offset = 2] {', 
                'line-width: 3;', 
            '}', 
        '}', 
        '', 
        '#worls[frame-offset = 10] {', 
            'line-width: 4;', 
        '}'
    ].join('\n');

    var shader = (new carto.RendererJS({ debug: true })).render(style);

    var css = shader.getLayers()[1];*/

    var newDataSource = new Cesium.GeoJsonDataSource();
    
    //update default point/line/polygon
    var defaultPoint = newDataSource.defaultPoint;
    var point = new Cesium.DynamicPoint();
    point.color = new Cesium.ConstantProperty(getCesiumColor(layer.style.point.color));
    point.pixelSize = new Cesium.ConstantProperty(layer.style.point.size);
    point.outlineColor = new Cesium.ConstantProperty(Cesium.Color.BLACK);
    point.outlineWidth = new Cesium.ConstantProperty(1);
    defaultPoint.point = point;
    
    var defaultLine = newDataSource.defaultLine;
    var polyline = new Cesium.DynamicPolyline();
    var material = new Cesium.ColorMaterialProperty();
    material.color = new Cesium.ConstantProperty(getCesiumColor(layer.style.line.color));
    polyline.material = material;
    polyline.width = new Cesium.ConstantProperty(layer.style.line.width);
    //defaultLine.polyline = polyline;

    var defaultPolygon = newDataSource.defaultPolygon;
    
    //defaultPolygon.polyline = polyline;
    
    var polygon = new Cesium.DynamicPolygon();
    polygon.fill = new Cesium.ConstantProperty(layer.style.polygon.fill);
    polygon.outline = new Cesium.ConstantProperty(true);
    polygon.outlineColor = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString('red'));
    defaultPolygon.polygon = polygon;
    
    material = new Cesium.ColorMaterialProperty();
    material.color = new Cesium.ConstantProperty(getCesiumColor(layer.style.polygon.fillcolor));
    polygon.material = material;
    
   //Reprojection and downsampling
    var crs_code = getCrsCode(geojson);
    if (crs_code !== '' && crs_code !== 'EPSG:4326') {
        if (!supportedProjection(crs_code)) {
//            addProj4Text(code); // post POC
            console.log('Unsupported data projection:', crs_code);
            return;
        }
        else {
            reprojectGeoJSON(geojson, crs_code);
        }
    }

    //try to downsample object if huge
    _downsampleGeoJSON(geojson);
    
    if (this.map === undefined) {
            //create the object
        newDataSource.load(geojson);
        this.dataSourceCollection.add(newDataSource);
            //add it as a layer
        layer.dataSource = newDataSource;
        if (!layer.extent) {
            layer.extent = getDataSourceExtent(newDataSource);
        }
    }
    else {
        var style = {
            "color": layer.style.line.color.toCssColorString(),
            "weight": layer.style.line.width,
            "opacity": 0.9
        };

        var geojsonMarkerOptions = {
            radius: layer.style.point.size / 2.0,
            fillColor: layer.style.point.color.toCssColorString(),
            fillOpacity: 0.9,
            color: "#000",
            weight: 1,
            opacity: 0.9
        };

/*        
         // icons will show up for leaflet print, but unable to set color
        var geojsonIcon = L.icon({
            iconUrl: 'images/pow32.png'
        });
*/
        // GeoJSON
        layer.primitive = L.geoJson(geojson, {
            style: style,
            pointToLayer: function (feature, latlng) {
                return L.circleMarker(latlng, geojsonMarkerOptions);
            }
        }).addTo(this.map);
    }
    return this.add(layer);
};

/**
* Determine if a proxy should be used based on the url
*
* @param {Url} url Url of the data item
*
* @returns {Boolean} true if should proxy
*/
GeoDataCollection.prototype.shouldUseProxy = function(url) {
    if (!this._alwaysUseProxy) {
        return false;
    } else if (url.indexOf('http') < 0) {
        return false;
    }
    return true;
};


/**
* Add a file object to the layers
*
* @param {Object} file A javascript file object
*
*/
GeoDataCollection.prototype.addFile = function(file) {
    var that = this;

    if (this.formatSupported(file.name)) {
        if (file.name.match(/.kmz$/i)) {
            var kmlLayer = new GeoData({ name: file.name, type: 'DATA' });

            var dataSource = new KmlDataSource(corsProxy);
            when(dataSource.loadKmz(file, file.name), function() {
                kmlLayer.extent = getDataSourceExtent(dataSource);
                that.dataSourceCollection.add(dataSource);
                kmlLayer.dataSource = dataSource;
                that.zoomTo = true;
                that.add(kmlLayer);
            });
        } else {
            when(readText(file), function (text) {
                that.zoomTo = true;
                that.loadText(text, file.name);
            });
        }
    }
    else {
        if (file.size > 1000000) {
            alert('File is too large to send to conversion service.  Click here for alternative file conversion options.');
        }
          //TODO: check against list of support extensions to avoid unnecessary forwarding
        else {
            if (!confirm('No local format handler.  Click OK to try to convert via our web service.')) {
                return;
            }
            // generate form data to submit text for conversion
            var formData = new FormData();
            formData.append('input_file', file);

            var xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    var response = xhr.responseText;
                    if (response.substring(0,1) !== '{') {
                        console.log(response);
                        alert('Error trying to convert: ' + file.name);
                    }
                    else {
                        that.zoomTo = true;
                        that.loadText(response, file.name, "GEOJSON");
                    }
                }
            };
            xhr.open('POST', that.supportServer + '/convert');
            xhr.send(formData);
        }
    }
};

module.exports = GeoDataCollection;

