process.log = function(){
	var array = [];
	for(var i=0; i<arguments.length; i++){
		array.push(arguments[i]);
	}
	array.unshift('[' + process.argv[3] + ']');
	process.api.log.apply(this, array);
};

console.log = process.log;

vmscript.watch('Config/world.json');
vmscript.watch('Config/network.json');

vms('Zone', [
	'Config/world.json',
	'Config/network.json'
], function(){
	CachedBuffer = require('./Modules/CachedBuffer.js');
	PacketCollection = require('./Modules/PacketCollection.js');
	restruct = require('./Modules/restruct');
	Database = require('./Modules/db.js');
	util = require('./Modules/util.js');
	util.setupUncaughtExceptionHandler(process.log);
	packets = require('./Helper/packets.js');
	nav_mesh = require('./Modules/navtest-revised.js');
	QuadTree = require('./Modules/QuadTree.js');

	vmscript.watch('./Generic/structs.js');
	vmscript.watch('./Generic/CharacterState.js');
	vmscript.watch('./Generic/CVec3.js');
	vmscript.watch('./Generic/CharacterInfos.js');

	function ZoneInstance(){
		this.initialized = false;
		this.packetCollection = null;
		this.socketTransferQueue = {};
		this.send = {};
		this.recv = {};
		this.id = parseInt(process.argv[2]);
		this.name = process.argv[3];
		this.navigation = null;
		this.QuadTree = null;
		this.Clients = [];
	}

	ZoneInstance.prototype.clientNodeUpdate = function(node, delta) {
		return { x: this.character.state.Location.X, y: this.character.state.Location.Z, size: this.character.state.Level };
	};

	ZoneInstance.prototype.addSocket = function(socket){
		if(!this.QuadTree){
			process.log("QuadTree is not initialized");
			return false;
		}else{
			this.Clients.push(socket);
			socket.node = this.QuadTree.addNode(new QuadTree.QuadTreeNode({
				object: socket,
				update: this.clientNodeUpdate,
				type: 'client'
			}));
			socket.character.state.UniqueID = socket.node.id;
			return true;
		}
	};

	ZoneInstance.prototype.sendToAllArea = function(origional, sendtoself, buffer, distance){
		for(var i=this.Clients.length-1; i >= 0; i--){
			var client = this.Clients[i];
	        if(sendtoself === false && client === origional) continue;
	        if(client.character.state.Location.getDistance(origional.character.state.Location) <= distance) {
	            client.write(buffer);
	        }
		}

	    // this.Clients.forEach(function(client) {
	    //     // if(client.authenticated == false || !client._handle) return;
	    //     if(sendtoself === false && client === origional) continue;
	    //     if(client.character.state.Location.getDistance(origional.character.state.Location) <= distance) {
	    //         client.write(buffer);
	    //     }
	    // });
	};

	ZoneInstance.prototype.findPath = function(){
		process.log("Navigation not initialized");
		return null;
	};

	ZoneInstance.prototype.onDisconnect = function(socket){
		// this.QuadTree.removeNode(socket.node.id);
		var index = this.Clients.indexOf(socket);
		if(index > -1){
			this.Clients.splice(this.Clients.indexOf(socket), 1);
			socket.character.save();
			process.log(socket.character.Name, "disconnected");
		}
	};

	ZoneInstance.prototype.onError = function(err, socket){
		process.log(socket.character.Name, "disconnected with error");
	};

	ZoneInstance.prototype.onFindCharacter = function(socket, err, character){
		if(err) {
			process.log(err);
			socket.destroy();
			return;
		}

		if(!character){
			process.log("Character not found");
			socket.destroy();
			return;
		}

	
		socket.character = character;
		socket.character.infos = new CharacterInfos(socket);
		var self = this;
		socket.character.infos.updateAll(function(){
			socket.character.state = new CharacterState();
			socket.character.state.setAccountID(socket.character.AccountID);
			socket.character.state.setCharacterID(socket.character._id);
			socket.character.state.setFromCharacter(socket.character);

			self.addSocket(socket);
			

			CachedBuffer.call(socket, self.packetCollection);
			Zone.sendToAllArea(socket, true, socket.character.state.getPacket(), config.network.viewable_action_distance);
			process.log(character.Name, "connected");
		});
	};

	ZoneInstance.prototype.onMessage = function(type, socket){
		var self = this;
		if(socket)
		switch(type){
			case 'world socket':
			socket.on('end', function() {
				return self.onDisconnect(socket);
			});

			socket.on('close', function() {
				return self.onDisconnect(socket);
			});

			socket.on('disconnect', function() {
				return self.onDisconnect(socket);
			});

			socket.on('error', function(err) {
				return self.onError(err, socket);
			});

			var hash = socket.remoteAddress + ":" + socket.remotePort;
			var characterData = this.socketTransferQueue[hash];
			if(!characterData){
				process.log("could not retrive character data.");
				socket.destroy();
				return;
			}

			delete this.socketTransferQueue[hash]; 

			db.Character.findOne({
				_id: characterData.id,
				AccountID: characterData.accountID
			}, function(err, character) {
				return self.onFindCharacter(socket, err, character);
			});
			break;
		}
		else switch(type.type){
			case 'character data':
			this.socketTransferQueue[type.data.hash] = type.data;
			break;
		}
	};

	ZoneInstance.prototype.init = function(){
		if(this.initialized) return;
		this.initialized = true;

		function roundDivisable(v,d) {
		    return (Math.round(v / d) * d) || d;
		}
		var startTime = new Date().getTime();
		
		this.packetCollection = new PacketCollection('ZonePC');

		var self = this;
		process.on('message', function(type, socket){return global.Zone.onMessage(type, socket);});
		// console.log("Loading navigation mesh for", this.name);
		var mesh_path = config.world.data_path + "navigation_mesh/" + this.name + '.obj';
		this.navigation = new nav_mesh(mesh_path, function(mesh){
			// process.log("Navigation mesh loaded for", self.name);
			// ZoneInstance.prototype.findPath = mesh.findPath;
			// findPath(from, to, actor_radius, callback)
			// from			- object, format: {x, y, z}
			// to			- object, format: {x, y, z}
			// actor_radius	- float
			// callback		- function, returning waypoints

			var height = Math.abs(mesh.dimensions.bottom) + Math.abs(mesh.dimensions.top);
			var width = Math.abs(mesh.dimensions.right) + Math.abs(mesh.dimensions.left);

			self.QuadTree = new QuadTree({
				x: roundDivisable(mesh.dimensions.left, 2),
				y: roundDivisable(mesh.dimensions.top, 2),
				size: roundDivisable(Math.max(width, height), 2)
			});

			Database(config.world.database.connection_string, function(){
				// process.log("Zone connected @", config.world.database.connection_string);
				vmscript.watch('Database');
				vmscript.watch('./Processes/Zone/Packets').on([
						'Packets',
						'Database',
						'Generic/structs.js',
						'Generic/CharacterState.js',
						'Generic/CVec3.js',
						'Generic/CharacterInfos.js'
					], function(){
						process.log("Initialized in", (new Date().getTime() - startTime), "ms");
						self.acceptConnections = true;
						process.api.run();
						process.api.nextTick();
				});
			});
		});
	}

	if(typeof Zone === 'undefined')
		global.Zone = new ZoneInstance();
	else
		global.Zone.__proto__ = ZoneInstance.prototype;

	global.Zone.init();
});