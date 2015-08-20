// TODO: Removing socket from zone on disconnet.

vmscript.watch('Config/world.json');
vmscript.watch('Config/network.json');

vms('Zone', [
			'Config/world.json',
			'Config/network.json'
		], function() {

global.api.zoneAlive = function(callback, client){
	console.log("Got zone alive callback", client);
	var c = Zone.clientHashTable[client];
	if(!c){
		console.log("Checking one alive for unknown client");
		return;
	}
	global.rpc.getCallback(callback).apply(c);
};

global.api.onMoveRegions = function(callback, client, moveRegions){
	console.log("Got move regions callback", client);
	var c = Zone.clientHashTable[client];
	if(!c){
		console.log("Checking move region for unknown client in zone", Zone.id);
		return;
	}

	global.rpc.getCallback(callback).call(c, moveRegions);
};

global.api.onCharacterZone = function(user_hash, zone, character_name, callback){
	var c = Zone.clientHashTable[user_hash];
	if(!c){
		console.log("On character zone from world have not founded client with hash". user_hash);
		return;
	}

	rpc.getCallback(callback).call(c, character_name, zone);
};

global.api.invalidateGuildForClient = function(client){
	var c = Zone.clientNameTable[client];
	if(!c){
		return;
	}

	if(c.writable && c.character.state.Guild){
		c.character.state.Guild.invalidate(c.character.state, function(guild){
			c.write(new Buffer(Zone.send.onGuildToClient.pack({
		    PacketID: 0x54,
		    Switch: 0x42,
		    InvitedBy: guild.name,
		    GuildName: guild.name
		  })));

			console.log(c.character.Name);

			c.character.state.setGuild(guild);
			// Find a better way maybe.
			Zone.sendToAllArea(c, false, c.character.state.getPacket(), config.network.viewable_action_distance);
		});
	}
};

global.api.sendBufferToClient = function(client, buffer){
	var c = Zone.clientNameTable[client];
	if(!c){
		return;
	}

	if(c.writable) c.write(buffer.buffer);
};


global.api.expelFromGuild = function(client, buffer){
	var c = Zone.clientNameTable[client];
	if(!c){
		return;
	}

	console.log("SOme1 gots expelled :D");

	c.write(buffer.buffer);
	c.character.state.removeGuild();
	c.character.GuildName = null;
	Zone.sendToAllArea(c, true, c.character.state.getPacket(), config.network.viewable_action_distance);
};

global.api.reloadCharacterData = function(name){
	var client = Zone.clientNameTable[name];
	if(!client){
		log.info("Could not reload data for", name);
		return;
	}

	db.Character.findOne({Name: name}, function(err, character){
		if(err){
			return;
		}

		if(!character){
			return;
		}

		for(var name in character){
			client.character[name] = character[name];
		}

		var CharacterData = new Buffer(Zone.send.CharacterInfo.pack({
			PacketID: 0x16,
			Status: 0,
			character: client.character,
			Unknown: 0x00
		}));

		CharacterData = client.character.restruct(CharacterData);
		client.write(CharacterData);
		Zone.sendToAllArea(client, true, client.character.state.getPacket(), config.network.viewable_action_distance);
	});
};

global.rpc.add(global.api);

function ZoneInstance() {
	fs = require('fs');
	util = require('./Modules/util.js');
	CachedBuffer = require('./Modules/CachedBuffer.js');
	PacketCollection = require('./Modules/PacketCollection.js');
	restruct = require('./Modules/restruct');
	Database = require('./Modules/db.js');
	packets = require('./Helper/packets.js');
	nav_mesh = require('./Modules/navtest-revised.js');
	QuadTree = require('./Modules/QuadTree.js');
	Random = require("random-js");
	random = new Random(Random.engines.mt19937().autoSeed());
	clone = require('clone');
	bunyan = require('bunyan');
	uuid = require('node-uuid');

	vmscript.watch('./Generic');
	vmscript.watch('./Helper/GMCommands.js');

	this.initialized = false;
	this.packetCollection = null;
	this.socketTransferQueue = {};
	this.send = {};
	this.recv = {};
	this.id = parseInt(process.argv[2]);
	this.name = process.argv[3];
	this.display_name = process.argv[4] || ''+this.id;
	this.clean_name = this.display_name.replace(/[\s#@]/gi, '');
	this.AI = null;
	this.QuadTree = null;
	this.Clients = [];
	this.Npc = [];
	this.Items = [];
	this.NpcNodesHashTable = {};
	this.clientHashTable = {};
	this.clientNodeTable = {};
	this.clientNameTable = {};
	this.itemSlotSizes = {};

	global.log = bunyan.createLogger({
		name: 'InfiniteSky/Zone.' + parseInt(process.argv[2]),
		streams: [{
			stream: process.stderr
		}]
	});

	util.setupUncaughtExceptionHandler(function(err){ log.error(err); });
}

if (!global.zonePrototype) {
	zonePrototype = ZoneInstance.prototype;
};

zonePrototype.addNPC = function(element){
	var npc = new Npc(element);
	npc.setNode(this.QuadTree.addNode(new QuadTree.QuadTreeNode({
		object: npc,
		update: function() {
			this.x = this.translateX(this.object.Location.X);
			this.y = this.translateY(this.object.Location.Z);
		},
		type: 'npc'
	})));
	this.Npc.push(npc);
};

zonePrototype.init = function Zone__init() {
	var self = this;

	// Only allow init once.
	if (this.inited) return;
	this.inited = true;
	this.packetCollection = new PacketCollection('ZonePC');
	global.ZonePC = this.packetCollection;
	Database(config.world.database.connection_string, function() {
		log.info("Zone database connected");
		self.databaseConnected = true;

		vmscript.watch('Database');
		vmscript.watch('Generic');

		vmscript.on([
			'Database',
			'Generic'
		], function() {
			vmscript.on('ItemInfo', function(){
				db.Item.find(null, '_id ItemType', function(err, docs){
					if(err){
						console.log(err);
						return;
					}

					for(var i=0; i<docs.length; i++){
						self.itemSlotSizes[docs[i]._id] = docs[i].getSlotSize();
					}

					docs.length = 0;
					if(typeof global.gc === 'function') global.gc();

					function vmscript_WatchIfExists(path) {
						fs.stat(path, function(err, stat) {
							if (err) {
								// Safe to ignore errors for this sometimes they wont exist.
								return;
							}

							vmscript.watch(path);
						});
					}

					vmscript_WatchIfExists('./Commands');
					vmscript_WatchIfExists('./Processes/Zone/Packets');
					vmscript_WatchIfExists('./Processes/Zone/Packets/'+self.id);
					vmscript_WatchIfExists('./Processes/Zone/Packets/'+self.clean_name);
					vmscript_WatchIfExists('./Processes/Zone/Commands');
					vmscript_WatchIfExists('./Processes/Zone/Commands/'+self.id);
					vmscript_WatchIfExists('./Processes/Zone/Commands/'+self.clean_name);
					vmscript_WatchIfExists('./Processes/Zone/Scripts/'+self.id);
					vmscript_WatchIfExists('./Processes/Zone/Scripts/'+self.clean_name);
				});
			});
		});
	});

	zonePrototype.initSpawn = function(){
		var self = this;
		fs.readFile(config.world.data_path + 'spawninfo/' + util.padLeft(self.id,'0', 3) + '.NPC', function(err, data) {
			if (err) {
				//console.log(err);
			} else {
				var RecordCount = data.readUInt32LE(0);

				var spawndata = restruct.struct('info', structs.SpawnInfo, RecordCount).unpack(data.slice(4));
				var length = spawndata.info.length,
					element = null;
				for (var i = 0; i < length; i++) {
					element = spawndata.info[i];
					if (element.ID) {
						self.addNPC(element);
					}
				}
			}
		});
	};

	// Load Navigation Mesh
	var mesh_path = config.world.data_path + "navigation_mesh/" + this.name + '.obj';
	fs.stat(mesh_path, function(err) {
		if (err) {
			// TODO: Add excpetion handler if we have no mesh to set the dimensions for quadtree.
			self.QuadTree = new QuadTree({
				x: -10000,
				y: -10000,
				size: 20000
			});
			self.initSpawn();
			return;
		}
		self.AI = new nav_mesh(mesh_path, function(mesh) {
			var height = Math.abs(mesh.dimensions.bottom) + Math.abs(mesh.dimensions.top) + 2;
			var width = Math.abs(mesh.dimensions.right) + Math.abs(mesh.dimensions.left) + 2;

			self.QuadTree = new QuadTree({
				x: util.roundDivisable(mesh.dimensions.left, 2)-1,
				y: util.roundDivisable(mesh.dimensions.top, 2)+1,
				size: util.roundDivisable(Math.max(width, height), 2)
			});
			self.initSpawn();
		});
	});

	// Setup listener for process messages
	process.on('message', function(arg1, arg2) {
		self.onProcessMessage(arg1, arg2);
	});
};

zonePrototype.addSocket = function(socket) {
	if (!this.QuadTree) {
		console.log("QuadTree is not initialized");
		return false;
	}

	// Attach functions to the socket here
	// TODO: See if we can get this to work prototype like.
	socket.sendInfoMessage = function(type, message) {
		if (arguments.length === 1) {
			message = type;
			type = ':INFO';
		}
		ZonePC.sendMessageToSocket(this, type, message);
	};

	socket.unhandledPacket = function(message) {
		ZonePC.sendMessageToSocket(this, ':WARN', 'Unhandled Packet: '+message);
	}

	socket.send2F = function(){
		this.write(new Buffer(structs.HealingReplyPacket.pack({
			'PacketID': 0x2F,
			'Level': this.character.Level,
			'Experience': this.character.Experience,
			'Honor': this.character.Honor,
			'CurrentHP': this.character.state.CurrentHP,
			'CurrentChi': this.character.state.CurrentChi,
			'PetActivity': this.character.Pet === null ? 0 : this.character.Pet.Activity,
			'PetGrowth': this.character.Pet === null ? 0 : this.character.Pet.Growth
		})));
	}

	socket.node = this.QuadTree.addNode(new QuadTree.QuadTreeNode({
		object: socket,
		update: function() {
			this.x = this.translateX(this.object.character.state.Location.X);
			this.y = this.translateY(this.object.character.state.Location.Z);
		},
		type: 'client'
	}));

	socket.character.state.NodeID = socket.node.id;
	var hash = uuid.v1();
	socket.hash = hash;
	this.clientHashTable[hash] = socket;
	this.clientNodeTable[socket.node.id] = socket;
	this.clientNameTable[socket.character.Name] = socket;

	return true;
};

zonePrototype.broadcastStates = function(client) {
	var found = Zone.QuadTree.query({
		CVec3: client.character.state.Location,
		radius: config.network.viewable_action_distance,
		type: ['npc', 'item']
	});
	for (var i = 0; i < found.length; i++) {
		var f = found[i];
		client.write(f.object.getPacket());
	}
};

zonePrototype.sendToAllAreaLocation = function(location, distance, buffer) {
	var found = this.QuadTree.query({
		CVec3: location,
		radius: distance,
		type: ['client']
	});
	for (var i = 0; i < found.length; i++) {
		var f = found[i];
		f.object.write(buffer);
	}
};

zonePrototype.sendToAllArea = function(client, self, buffer, distance) {
	var found = this.QuadTree.query({
		CVec3: client.character.state.Location,
		radius: distance,
		type: ['client']
	});
	for (var i = 0; i < found.length; i++) {
		var f = found[i];
		if (!self && f.object === client) continue;
		if (f.object.write) f.object.write(buffer);
	}
};

zonePrototype.sendToAllAreaClan = function(client, self, buffer, distance, clan){
	if (clan === undefined) {
		clan = client.character.Clan;
	}

  var found = this.QuadTree.query({ CVec3: client.character.state.Location, radius: distance, type: ['client'] });
  for(var i=0; i<found.length; i++){
      var f = found[i];
      if(!self && f.object === client) continue;
      if (f.object.character.Clan !== clan) continue;
      if(f.object.write) f.object.write(buffer);
  }
};

zonePrototype.onFindAccount = function(socket, err, account) {
	socket.account = account;
}



// Moves a character socket to a location and optionally a zoneID (Not yet implemented)
// Returns false if it failed, true if success
zonePrototype.move = function zone_move_character_socket(socket, location, zoneID) {
    //var ChangeZone = false;
    // Teleport to zone
    // Make sure zoneID is number.
    // if(zoneID && zoneID != this.character.MapID) {
    //     var thePort = 0;
    //     var theIP = '';
    //     var status = 0;
    //     console.log("Teleporting to Zone ID's not tested yet");
    //     // Check if zone id exists
    //     var TransferZone = worldserver.findZoneByID(zoneID);
    //     if(TransferZone == null) {
    //         console.log("Zone not found");
    //         status = 1;
    //         this.write(
    //         new Buffer(
    //         packets.MapLoadReply.pack({
    //             packetID: 0x0A,
    //             Status: status,
    //             IP: theIP,
    //             Port: thePort
    //         })));
    //         return false;
    //     }
    //     console.log('Zone found');
    //     if(Location) {
    //         // Use the location
    //         console.log('Location set');
    //         this.character.state.Location.X = location.X;
    //         this.character.state.Location.Y = location.Y;
    //         this.character.state.Location.Z = location.Z;
    //         this.character.state.Skill = 0;
    //         this.character.state.Frame = 0;
    //         this.sendActionStateToArea();
    //     } else {
    //         // Get a location for the zone
    //         console.log('Finding portal 0 endpoint');
    //         var PortalEndPoint = TransferZone.getPortalEndPoint(0);
    //         if(PortalEndPoint) {
    //             console.log('Location set');
    //             this.character.state.Location.X = PortalEndPoint.X;
    //             this.character.state.Location.Y = PortalEndPoint.Y;
    //             this.character.state.Location.Z = PortalEndPoint.Z;
    //             // Get random spot in that radius?
    //         } else {
    //             console.log('Location not set');
    //             this.character.state.Location.X = 0;
    //             this.character.state.Location.Y = 0;
    //             this.character.state.Location.Z = 0;
    //         }
    //     }
    //     // The Character State object for use in world for moving and health etc.
    //     //this.character.state.setFromCharacter(this.character);
    //     //console.log(this.character.state.Location);
    //     // Ask the zones/mapservers if they are ready for connections
    //     // If not then set Status to 1
    //     //status = 1;
    //     // Add to WorldServer client transfer.
    //     // Set the zoneID and XYZ they are to goto.
    //     this.character.MapID = TransferZone.getID();
    //     this.zoneTransfer = true;
    //     this.zoneForceTransfer = true;
    //     worldserver.addSocketToTransferQueue(this);
    //     console.log('Tell client which map server to connect too');
    //     //socket.characters[gamestart.Slot].MapID << get the map id of character :P
    //     // Get world.clients ip, check if it is on lan with server,
    //     // if so send it servers lan ip and port
    //     // otherwise send it real world ip and port
    //     theIP = config.externalIP;
    //     if(_util.cleanIP(this.remoteAddress).indexOf('127') == 0) {
    //         theIP = '127.0.0.1'
    //     }
    //     console.log('IP for client to connect too before translation: ' + theIP);
    //     for(var i = 0; i < natTranslations.length; i++) {
    //         if(natTranslations[i].contains(_util.cleanIP(this.remoteAddress))) {
    //             theIP = natTranslations[i].ip;
    //             break;
    //         }
    //     }
    //     console.log('IP for client to connect too: ' + theIP);
    //     thePort = config.ports.world;
    //     console.log({
    //         packetID: 0x0A,
    //         Status: status,
    //         IP: theIP,
    //         Port: thePort
    //     });
    //     this.account.save();
    //     this.character.save();
    //     this.write(
    //     new Buffer(
    //     packets.MapLoadReply.pack({
    //         packetID: 0x0A,
    //         Status: status,
    //         IP: theIP,
    //         Port: thePort
    //     })));
    //     return true;
    // }
    var oldLocation = socket.character.state.Location.copy();
    if(location) {
        socket.character.state.Location.X = location.X;
        socket.character.state.Location.Y = location.Y;
        socket.character.state.Location.Z = location.Z;
    }
    // Send character update packet
    socket.character.state.Skill = 0;
    socket.character.state.Frame = 0;

    var packet = socket.character.state.getPacket();
    Zone.sendToAllAreaLocation(oldLocation, config.network.viewable_action_distance, packet);
    Zone.sendToAllArea(socket, true, packet, config.network.viewable_action_distance);
    return true;
};


zonePrototype.giveEXP = function zone_giveEXP(socket, value) {
    var oldLocation = socket.character.state.Location.copy();
    if(location) {
        socket.character.state.Location.X = location.X;
        socket.character.state.Location.Y = location.Y;
        socket.character.state.Location.Z = location.Z;
    }
    // Send character update packet
    socket.character.state.Skill = 0;
    socket.character.state.Frame = 0;

    var packet = socket.character.state.getPacket();
    Zone.sendToAllAreaLocation(oldLocation, config.network.viewable_action_distance, packet);
    Zone.sendToAllArea(socket, true, packet, config.network.viewable_action_distance);
    return true;
};

zonePrototype.onProcessMessage = function(type, socket) {
	if (socket) switch (type) {
		case 'socket':
			// console.log(socket);
			socket.on('close', function(err) {
				if(socket.node){
					console.log("Node removed");
					Zone.QuadTree.remove(socket.node);
					socket.node = null;
				}
				// socket.character.save(function(){
				// 	console.log("Saved");
				// });
			});
			socket.on('error', function(err) {
				if(socket.node){
					console.log("Node removed");
					Zone.QuadTree.remove(socket.node);
					socket.node = null;
				}
				// socket.character.save(function(){
				// 	console.log("Saved");
				// });
			});
			socket.on('timeout', function() {});

			var hash = socket.remoteAddress + ":" + socket.remotePort;
			var characterData = this.socketTransferQueue[hash];
			if (!characterData) {
				console.log("could not retrive character data.");
				socket.destroy();
				return;
			}

			delete this.socketTransferQueue[hash];

			var self = this;
			db.Character.findOne({
				_id: characterData.id,
				AccountID: characterData.accountID
			}, function(err, character) {
				console.log("got character");
				if (err) {
					// console.log(err);
					// TODO: Consider socket.disconnect
					socket.destroy();
					return;
				}

				if (!character) {
					// console.log("Character not found");
					socket.destroy();
					return;
				}

				// Get account details
				db.Account.findOne({_id: characterData.accountID},function(err, account) {
					return self.onFindAccount(socket, err, account);
				});

				socket.character = character;
				socket.character.infos = new CharacterInfos(socket);
				socket.character.infos.updateAll(function() {
					socket.character.state = new CharacterState();
					socket.character.state.setAccountID(socket.character.AccountID);
					socket.character.state.setCharacterID(socket.character._id);
					socket.character.state.setFromCharacter(socket.character);

					self.addSocket(socket);

					if(socket.character.GuildName){
						db.Guild.findByName(socket.character.GuildName, function(err, guild){
							if(err){
								return;
							}

							if(!guild){
								return;
							}

							socket.character.state.setGuild(guild);

							CachedBuffer.call(socket, self.packetCollection);
							Zone.sendToAllArea(socket, true, socket.character.state.getPacket(), config.network.viewable_action_distance);
						});
						return;
					}

					CachedBuffer.call(socket, self.packetCollection);
					Zone.sendToAllArea(socket, true, socket.character.state.getPacket(), config.network.viewable_action_distance);
				});
			});

			break;
	} else switch (type.type) {
		case 'character':
			this.socketTransferQueue[type.data.hash] = type.data;
			break;
	}
};

if (!global.Zone) {
	global.Zone = new ZoneInstance();
	Zone.init();
}
});
