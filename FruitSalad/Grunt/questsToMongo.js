module.exports = function(grunt) {
  grunt.registerTask('questsToMongo', 'Loads Quests from the game file 005_00007.IMG into Mongo.', function() {
  	var done = this.async();

	var vmscript = new (require('../VMScript.js'))();
	Database = require('../Modules/db.js');
	var GameInfoLoader = require('../Modules/GameInfoLoader.js');
	var restruct = require('../Modules/restruct');
	var encoding = require("encoding");

  	vmscript.on(['config'], function() {
  		console.log('Starting config check for questsToMongo.');
  		if (!config.world) {
			console.error('Expecting config.world to be set.');
	  		return done(false);
  		}

	  	if (!config.world.database || !config.world.database.connection_string) {
	  		console.error('Expecting config.world.database.connection_string to be set.');
	  		return done(false);
	  	}

	  	if (!config.world.info_directory) {
	  		console.error('Expecting config.world.info_directory to be set. Please run grunt init or grunt locateGameFiles.');
	  		return done(false);
	  	}

		Database(config.world.database.connection_string, function(){
			console.log("Database connected");
			vmscript.watch('Database/quest.js');
		});

  	});

  	vmscript.on(['QuestInfo'], function() {
  		console.log('Clearing all existing Quests in MongoDB.');
  		db.Quest.remove().exec();

  		var makeCSV = true;
  		var csv = null;
  		if (makeCSV) {
  			var fs = require('fs');
  			csv = fs.createWriteStream('Quests.csv');
			csv.write("id, Name, Level, Clan, QuestNumber, Unknown4, Unknown4a, Unknown5, InQuestDestPacket1, Unknown7, Unknown8, FromNPCID, Unknown10, Unknown11, Unknown12, Unknown13, Unknown14, ToNPCID, MonsterID, Value, Unknown17, Unknown18, Unknown19, RewardItem, Unknown21, RewardExperience, Unknown23, Unknown24, InitalTextPageCount, Text1, Text2, Text3, Text4, Text5, Text6, Text7, Text8, Text9, Text10\n");
     	}

  		var textPage = restruct.
  		string("1", 51, 15).
  		string("2", 51, 15).
  		string("3", 51, 15).
        string("4", 51, 15).
        string("5", 51, 15).
        string("6", 51, 15).
        string("7", 51, 15).
		string("8", 51, 15).
		string("9", 51, 15).
		string("10", 51, 15).
		pad(2);

		console.log('Please wait loading info into database may take some time.');
		var Quests = new GameInfoLoader('005_00007.IMG',
			restruct.
			int32lu("id").
			int32lu("Clan").
			int32lu("QuestNumber").  // 1 based number of quest for each clan.
			int32lu("Level").        // Can also be level of monster to drop item.
			int32lu("Unknown4").
			int32lu("Unknown4a").
			int32lu("Unknown5").
			int32lu("InQuestDestPacket1"). // This is in the quest destination packet, that client sends to server when it is at the spot a monster should spawn. I have no idea what it is.
			int32lu("Unknown7").
			int32lu("Unknown8").
			string("Name",52).
			int32lu("FromNPCID").
			int32lu("Unknown10").
			int32lu("Unknown11").
			int32lu("Unknown12").
			int32lu("Unknown13").
			int32lu("Unknown14").
			int32lu("ToNPCID").
			int32lu("MonsterID").     // Can also be item that the monster of level will drop.
			int32lu("Value").         // Used for item oramount to killl depending on quest type.
			int32lu("Unknown17").
			int32lu("Unknown18").
			int32lu("Unknown19").
			int32lu("RewardItem").
			int32lu("Unknown21").
			int32lu("RewardExperience").
			int32lu("Unknown23").
			int32lu("Unknown24").
			int32lu("InitalTextPageCount").
			struct("Texts", textPage),
			  function onRecordLoad(record) {
			  	if (record.id !== undefined && record.id > 0) {
					//record.Name = encoding.convert(record.Name, 'UTF-8', 'EUC-KR').toString();
			  		console.log(record.id, record.Name);
					// Would have to trim if restruct did not do it already. .replace(/\0.*/,'')

			  		if (makeCSV) {
			  			var cols = [
							"id",
							"Name",
							"Level",
							"Clan",
							"QuestNumber",
							"Unknown4",
							"Unknown4a",
							"Unknown5",
							"InQuestDestPacket1",
							"Unknown7",
							"Unknown8",
							"FromNPCID",
							"Unknown10",
							"Unknown11",
							"Unknown12",
							"Unknown13",
							"Unknown14",
							"ToNPCID",
							"MonsterID",
							"Value",
							"Unknown17",
							"Unknown18",
							"Unknown19",
							"RewardItem",
							"Unknown21",
							"RewardExperience",
							"Unknown23",
							"Unknown24",
							"InitalTextPageCount"];

						var blankFillToText = '';
						for (var i=0;i<cols.length;i++) {
							if (i===0) {
								blankFillToText = '--';
							}
							blankFillToText += ',';
							var quote = false;
							if (cols[i] === "Name") {
								quote = true;
							}

							var value = record[cols[i]];
							if (quote) {
								csv.write('"'+value+'",');
							} else {
								csv.write(value+',');
							}
						}

						// Write text out on multiple rows.
						for (var i=0;i<15;i++) {
							if (i>0) { // If we are not on the very first line we want to pad in the starting area.
								csv.write(blankFillToText);
							}
							for (var j=1;j<=10;j++) {
								var value = record.Texts[j][i];
								csv.write('"'+value+'"' + (j < 10 ? ',' : '')); // Put comma after all but the last text
							}
							csv.write('\n');
						}
			  		}

			  		db.Quest.create(record, function(err, doc) {
			  			if (err) {
			  				console.error(err);
			  				return;
			  			}
			  		});
			  	}
			  }
			);

		Quests.once('loaded', function(){
			if (csv) {
				csv.on('finish', function() {
					done(true);
				});
				csv.end();
			} else {
				done(true);
			}
		});

  	});

	vmscript.watch('Config/world.json');
  });
};


