/*******************************************************************************
 * Copyright 2017 CNES - CENTRE NATIONAL d'ETUDES SPATIALES
 *
 * This file is part of MIZAR.
 *
 * MIZAR is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * MIZAR is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with SITools2. If not, see <http://www.gnu.org/licenses/>.
 ******************************************************************************/

define(['../Renderer/FeatureStyle', '../Renderer/VectorRendererManager', '../Utils/Utils', './AbstractLayer',
    '../Renderer/RendererTileData', '../Tiling/Tile',
    './JsVotable/JsVotable', './JsVotable/utils','./JsCSV/csv', '../Utils/Constants'],
    function (FeatureStyle, VectorRendererManager, Utils, AbstractLayer, RendererTileData, Tile, JsVotable, UtilsJsVotable, CSV, Constants) {

        /**************************************************************************************************************/

        /**
         * Hips catalogue configuration
         * @typedef {AbstractLayer.configuration} AbstractLayer.hipsCat_configuration
         * @property {string} serviceUrl - Endpoint to reach the Hips catalogue
         * @property {int} [minOrder = 2] - min order
         * @property {int} [maxRequests = 4] - Max requests in parallel
         * @property {boolean} [invertY = false]
         */

        /**
         * Create a HIPS catalogue
         * @param {AbstractLayer.hipsCat_configuration} options - Hip catalogue configuration
         * @constructor
         * @memberOf module:Layer
         * @see {@link http://www.ivoa.net/documents/HiPS/20170406/index.html Hips standard}
         */
        var HipsCatLayer = function (options) {
            AbstractLayer.prototype.constructor.call(this, Constants.LAYER.HipsCat, options);
            var propertiesObj = new Properties(options.serviceUrl + '/properties');
            var properties = propertiesObj.getProperties();
            var hips_order = properties['hips_order'];
            this.serviceUrl = options.serviceUrl;
            this.minOrder = options.minOrder || 2;
            this.maxOrder = Number.parseInt(hips_order);
            this.maxRequests = options.maxRequests || 4;
            this.invertY = options.invertY || false;
            var xhr = UtilsJsVotable.makeHttpObject();
            xhr.open('GET', options.serviceUrl + '/metadata.xml', false);
            xhr.send();
            var jsVotable = new JsVotable.Votable(xhr.responseXML);
            var resource = jsVotable.getResources()[0];
            var table = resource.getResourcesOrTables()[0]["TABLE"];
            this.fields = table.getFields();
            this.raColNumber = null;
            this.decColNumber = null;
            this.sourceId = null;
            for (i = 0; i < this.fields.length; i++) {
                var ucd = this.fields[i].ucd();
                if (ucd == 'pos.eq.ra') {
                    this.raColNumber = this.fields[i].name();
                } else if (ucd == 'pos.eq.dec') {
                    this.decColNumber = this.fields[i].name();
                } else if (ucd == 'meta.id;meta.main') {
                    this.sourceId = this.fields[i].name();
                }
            }
            

            this.extId = "hipsCat";

            // Used for picking management
            this.features = [];
            // Counter set, indicates how many times the feature has been requested
            this.featuresSet = {};

            // Maximum two requests for now
            this.freeRequests = [];
            this.tilesToLoad = [];

            // Build the request objects
            for (var i = 0; i < this.maxRequests; i++) {
                var xhr = new XMLHttpRequest();
                this.freeRequests.push(xhr);
            }
        };

        /**************************************************************************************************************/

        Utils.inherits(AbstractLayer, HipsCatLayer);

        /**************************************************************************************************************/

        /**
         * Parse properties file of the Hips catalogue
         * @param url
         * @constructor
         */
        var Properties = function (url) {
            this.properties = {};
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, false);
            xhr.send();
            var content = xhr.responseText;
            content.trim();
            var lines = content.split('\n');
            for (i = 0; lines != null && i < lines.length; i++) {
                var line = lines[i];
                if (line != null && (line.indexOf("#") > -1 || !line.trim() )) {
                    continue;
                }
                var keywordValue = line.split("=");
                var keyword = keywordValue[0].replace(/^\s+|\s+$/g, "");
                var value = keywordValue[1].replace(/^\s+|\s+$/g, "");
                this.properties[keyword] = value;
            }
        };

        /**
         * Returns the properties
         * @return {{}}
         */
        Properties.prototype.getProperties = function () {
            return this.properties;
        };

        /**
         * Attaches the layer to the globe
         * @param g The globe
         * @private
         */
        HipsCatLayer.prototype._attach = function (g) {
            AbstractLayer.prototype._attach.call(this, g);
            this.extId += this.id;
            g.tileManager.addPostRenderer(this);
        };

        /**************************************************************************************************************/

        /**
         * Detaches the layer from the globe
         * @private
         */
        HipsCatLayer.prototype._detach = function () {
            this.globe.tileManager.removePostRenderer(this);
            AbstractLayer.prototype._detach.call(this);
        };

        /**************************************************************************************************************/

        /**
         * Launches request to the HipsCatLayer service
         * @param tile
         * @param url
         * @fires Context#startLoad
         * @fires Context#endLoad
         * @fires Context#features:added
         */
        HipsCatLayer.prototype.launchRequest = function (tile, url) {
            var tileData = tile.extension[this.extId];
            var index = null;

            if (this.freeRequests.length == 0) {
                return;
            }

            // Set that the tile is loading its data for HipsCatLayer
            tileData.state = HipsCatLayer.TileState.LOADING;

            // Pusblish the start load event, only if there is no pending requests
            if (this.maxRequests == this.freeRequests.length) {
                this.globe.publishEvent("startLoad", this);
            }

            var xhr = this.freeRequests.pop();
            var self = this;
            xhr.onreadystatechange = function (e) {
                if (xhr.readyState == 4) {
                    if (xhr.status == 200) {
                        var response = {};
                        var headerInfo = {
                            'name':[],
                            'datatype':[]
                        };
                        self.fields.forEach(function(field) {
                            headerInfo.name.push(field.name());
                            headerInfo.datatype.push(field.datatype());
                        });
                        var csv = new CSV(xhr.response,"\t",headerInfo);
                        var geoJson = csv.getGeoJSon({"RA":self.raColNumber,"DEC":self.decColNumber,"ID":self.sourceId}, "Equatorial");
                        var features = geoJson.features;
                        response["features"] = features;
                        response["totalResults"] = features.length;

                        //var response = JSON.parse(xhr.response);

                        tileData.complete = (response.totalResults == response.features.length);

                        //self.updateFeatures(response.features);

                        for (var i = response.features.length - 1; i >= 0; i--) {
                            var feature = response.features[i];
                            // Eliminate already added features from response
                            var alreadyAdded = self.featuresSet.hasOwnProperty(feature.id);
                            if (alreadyAdded)
                                response.features.splice(i, 1);

                            feature.properties.style = this.style;
                            self.addFeature(feature, tile);
                        }
                        self.globe.refresh();

                        // Publish event that layer have received new features
                        if (response.hasOwnProperty(features) && response.features.length > 0) {
                            self.globe.publishEvent("features:added", {layer: self, features: response.features});
                        }
                    }
                    else if (xhr.status >= 400) {
                        tileData.complete = true;
                        console.error(xhr.responseText);
                    }

                    tileData.state = HipsCatLayer.TileState.LOADED;
                    self.freeRequests.push(xhr);

                    // Publish the end load event, only if there is no pending requests
                    if (self.maxRequests == self.freeRequests.length) {
                        self.globe.publishEvent("endLoad", self);
                    }
                }
            };
            xhr.open("GET", url);
            xhr.send();
        };




        /**************************************************************************************************************/

        /**
         * Adds feature to the layer and to the tile extension
         * @param feature
         * @param tile
         */
        HipsCatLayer.prototype.addFeature = function (feature, tile) {
            var tileData = tile.extension[this.extId];
            var featureData;

            // Add feature if it doesn't exist
            if (!this.featuresSet.hasOwnProperty(feature.id)) {
                this.features.push(feature);
                featureData = {
                    index: this.features.length - 1,
                    tiles: [tile]
                };
                this.featuresSet[feature.id] = featureData;
            }
            else {
                featureData = this.featuresSet[feature.id];

                // Store the tile
                featureData.tiles.push(tile);

                // Always use the base feature to manage geometry indices
                feature = this.features[featureData.index];
            }

            // Add feature id
            tileData.featureIds.push(feature.id);

            // Set the identifier on the geometry
            feature.geometry.gid = feature.id;

            // Add to renderer
            //this.addFeatureToRenderer(feature, tile);

            // MS: Feature could be added from ClusterOpenSearch which have features with different styles
            var style = feature.properties.style ? feature.properties.style : this.style;

            this.globe.vectorRendererManager.addGeometryToTile(this, feature.geometry, style, tile);
        };


        /**************************************************************************************************************/

        /**
         * Removes feature from Dynamic HipsCatLayer layer
         * @param identifier
         * @param tile
         */
        HipsCatLayer.prototype.removeFeature = function (identifier, tile) {
            var featureIt = this.featuresSet[identifier];

            if (!featureIt) {
                return;
            }

            // Remove tile from array
            var tileIndex = featureIt.tiles.indexOf(tile);
            if (tileIndex >= 0) {
                featureIt.tiles.splice(tileIndex, 1);
            }
            else {
                console.log('HipsCatLayer internal error : tile not found when removing feature');
            }

            if (featureIt.tiles.length == 0) {
                // Remove it from the set
                delete this.featuresSet[identifier];

                // Remove it from the array by swapping it with the last feature to optimize removal.
                var lastFeature = this.features.pop();
                if (featureIt.index < this.features.length) {
                    // Set the last feature at the position of the removed feature
                    this.features[featureIt.index] = lastFeature;
                    // Update its index in the Set.
                    this.featuresSet[lastFeature.id].index = featureIt.index;
                }
            }
        };

        /**************************************************************************************************************/

        /**
         * Modifies feature style
         * @param feature
         * @param style
         */
        HipsCatLayer.prototype.modifyFeatureStyle = function (feature, style) {
            feature.properties.style = style;
            var featureData = this.featuresSet[feature.id];
            if (featureData) {
                for (var i = 0; i < featureData.tiles.length; i++) {
                    var tile = featureData.tiles[i];
                    this.globe.vectorRendererManager.removeGeometryFromTile(feature.geometry, tile);
                    this.globe.vectorRendererManager.addGeometryToTile(this, feature.geometry, style, tile);
                }

            }
        };

        HipsCatLayer.TileState = {
            LOADING: 0,
            LOADED: 1,
            NOT_LOADED: 2,
            INHERIT_PARENT: 3
        };


        /**************************************************************************************************************/

        /**
         * Generates the tile data
         * @param tile
         */
        HipsCatLayer.prototype.generate = function (tile) {
            if (this.minOrder <= tile.order && tile.order <= this.maxOrder) {
                tile.extension[this.extId] = new OSData(this, tile, null);
            }

        };

        /**************************************************************************************************************/

        /**
         * HipsCatLayer renderable
         * @param layer
         * @param tile
         * @param p
         * @constructor
         */
        var OSData = function (layer, tile, p) {
            this.layer = layer;
            this.parent = p;
            this.tile = tile;
            this.featureIds = []; // exclusive parameter to remove from layer
            this.state = HipsCatLayer.TileState.NOT_LOADED;
            this.complete = false;
            this.childrenCreated = false;
        };

        /**************************************************************************************************************/

        /**
         * Traverse
         * @param tile
         */
        OSData.prototype.traverse = function (tile) {
            if (!this.layer.visible)
                return;

            if (tile.state != Tile.State.LOADED)
                return;

            // Check if the tile need to be loaded
            if (this.state == HipsCatLayer.TileState.NOT_LOADED) {
                this.layer.tilesToLoad.push(this);
            }

            // Create children if needed
            if (this.state == HipsCatLayer.TileState.LOADED && !this.complete
                && tile.state == Tile.State.LOADED && tile.children && !this.childrenCreated) {
                for (var i = 0; i < 4; i++) {
                    if (!tile.children[i].extension[this.layer.extId])
                        tile.children[i].extension[this.layer.extId] = new OSData(this.layer, tile.children[i], this);
                }
                this.childrenCreated = true;


                // HACK : set renderable to have children
                var renderables = tile.extension.renderer ? tile.extension.renderer.renderables : [];
                for (var i = 0; i < renderables.length; i++) {
                    if (renderables[i].bucket.layer == this.layer)
                        renderables[i].hasChildren = true;
                }
            }
        };

        /**************************************************************************************************************/
        /**
         * Disposes renderable data from tile
         * @param renderContext
         * @param tilePool
         */
        OSData.prototype.dispose = function (renderContext, tilePool) {
            if (this.parent && this.parent.childrenCreated) {
                this.parent.childrenCreated = false;
                // HACK : set renderable to not have children!
                var renderables = this.parent.tile.extension.renderer ? this.parent.tile.extension.renderer.renderables : [];
                for (var i = 0; i < renderables.length; i++) {
                    if (renderables[i].bucket.layer == this.layer)
                        renderables[i].hasChildren = false;
                }
            }

            for (var i = 0; i < this.featureIds.length; i++) {
                this.layer.removeFeature(this.featureIds[i], this.tile);
            }
            this.tile = null;
            this.parent = null;
        };

        /**************************************************************************************************************/

        /**
         * Builds URL
         * @param tile
         * @return {*}
         */
        HipsCatLayer.prototype.buildUrl = function (tile) {
            var url;
            if (tile.order <= 0) {
                url = this.serviceUrl + "/Norder" + tile.order + "/Allsky.xml";
            } else {
                url = this.serviceUrl;

                url += "/Norder";
                url += tile.order;

                url += "/Dir";
                var indexDirectory = Math.floor(tile.pixelIndex / 10000) * 10000;
                url += indexDirectory;

                url += "/Npix";
                url += tile.pixelIndex;
                url += ".tsv";
            }
            return url;
        };

        /**************************************************************************************************************/

        /**
         * Internal function to sort tiles
         * @param t1
         * @param t2
         * @return {number}
         * @private
         */
        function _sortTilesByDistance(t1, t2) {
            return t1.tile.distance - t2.tile.distance;
        }

        /**
         * Render function
         *
         * @param tiles The array of tiles to render
         */
        HipsCatLayer.prototype.render = function (tiles) {
            if (!this.visible)
                return;

            // Sort tiles
            this.tilesToLoad.sort(_sortTilesByDistance);

            // Load data for the tiles if needed
            for (var i = 0; i < this.tilesToLoad.length && this.freeRequests.length > 0; i++) {
                var tile = this.tilesToLoad[i].tile;
                var url = this.buildUrl(tile);
                if (url) {
                    this.launchRequest(tile, url);
                }
            }

            this.tilesToLoad.length = 0;
        };


        /*************************************************************************************************************/

        return HipsCatLayer;

    });