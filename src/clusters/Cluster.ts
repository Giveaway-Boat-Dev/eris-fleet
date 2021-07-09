import * as Eris from "eris";
import {worker} from "cluster";
import {BaseClusterWorker} from "./BaseClusterWorker";
import {inspect} from "util";
import { ShardStats, StartingStatus } from "../sharding/Admiral";
import { IPC } from "../util/IPC";

const ipc = new IPC();

export class Cluster {
	firstShardID!: number;
	lastShardID!: number;
	path!: string;
	clusterID!: number;
	clusterCount!: number;
	shardCount!: number;
	shards!: number;
	clientOptions!: Eris.ClientOptions;
	whatToLog!: string[];
	client!: Eris.Client;
	private token!: string;
	app?: BaseClusterWorker;
	App!: any;
	shutdown?: boolean;
	totalShardCount: number;
	private startingStatus?: StartingStatus;

	constructor(totalShardCount: number) {
		console.log = (...str: []) => {if (process.send) process.send({op: "log", msg: str.map(str => typeof str === 'string' ? str : inspect(str)).join(' '), source: "Cluster " + this.clusterID});};
		console.debug = (...str: []) => {if (process.send) process.send({op: "debug", msg: str.map(str => typeof str === 'string' ? str : inspect(str)).join(' '), source: "Cluster " + this.clusterID});};
		console.error = (...str: []) => {if (process.send) process.send({op: "error", msg: str.map(str => typeof str === 'string' ? str : inspect(str)).join(' '), source: "Cluster " + this.clusterID});};
		console.warn = (...str: []) => {if (process.send) process.send({op: "warn", msg: str.map(str => typeof str === 'string' ? str : inspect(str)).join(' '), source: "Cluster " + this.clusterID});};

		//Spawns
		process.on("uncaughtException", (err: Error) => {
			console.error(inspect(err));
		});

		process.on("unhandledRejection", (reason, promise) => {
			console.error("Unhandled Rejection at: " + inspect(promise) + " reason: " + reason);
		});

		if (process.send) process.send({op: "launched"});
		
		process.on("message", async message => {
			if (message.op) {
				switch (message.op) {
				case "connect": {
					this.firstShardID = message.firstShardID;
					this.lastShardID = message.lastShardID;
					this.path = message.path;
					this.clusterID = message.clusterID;
					this.clusterCount = message.clusterCount;
					this.shardCount = message.shardCount;
					this.shards = (this.lastShardID - this.firstShardID) + 1;
					this.clientOptions = message.clientOptions;
					this.token = message.token;
					this.whatToLog = message.whatToLog;
					if (message.startingStatus) this.startingStatus = message.startingStatus;

					if (this.shards < 0) return;
					this.connect();

					break;
				}
				case "fetchUser": {
					if (!this.client) return;
					const user = this.client.users.get(message.id);
					if (user) {
						if (process.send) process.send({op: "return", value: user, UUID: message.UUID});
					} else {
						if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
					}
						
					break;
				}
				case "fetchChannel": {
					if (!this.client) return;
					const channel = this.client.getChannel(message.id);
					if (channel) {
						if (process.send) process.send({op: "return", value: channel, UUID: message.UUID});
					} else {
						if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
					}

					break;
				}
				case "fetchGuild": {
					if (!this.client) return;
					const guild = this.client.guilds.get(message.id);
					if (guild) {
						if (process.send) process.send({op: "return", value: guild, UUID: message.UUID});
					} else {
						if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
					}

					break;
				}
				case "fetchMember": {
					if (!this.client) return;
					const messageParsed = JSON.parse(message.id);
					const guild = this.client.guilds.get(messageParsed.guildID);
					if (guild) {
						const member = (await guild.fetchMembers({userIDs: [messageParsed.memberID], presences: true}))[0];
						if (member) {
							const clean = member.toJSON();
							clean.id = message.id;
							if (process.send) process.send({op: "return", value: clean, UUID: message.UUID});
						} else {
							if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
						}
					} else {
						if (process.send) process.send({op: "return", value: {id: message.id, noValue: true}, UUID: message.UUID});
					}

					break;
				}
				case "return": {
					if (this.app) this.app.ipc.emit(message.id, message.value);
					break;
				}
				case "collectStats": {
					if (!this.client) return;
					const shardStats: ShardStats[] = [];
					const getShardUsers = (id: number) => {
						let users = 0;
						for(const [key, value] of Object.entries(this.client.guildShardMap)) {
							const guild = this.client.guilds.get(key);
							if (Number(value) == id && guild) users += guild.memberCount;
						}
						return users;
					};
					this.client.shards.forEach(shard => {
						const guildsInThisShard = this.client.guilds.filter((guild) => guild.shard.id === shard.id);

						shardStats.push({
							id: shard.id,
							ready: shard.ready,
							latency: shard.latency,
							status: shard.status,
							guilds: guildsInThisShard.length,
							unavailableGuilds: guildsInThisShard.filter((guild) => guild.unavailable === true).length,
							users: getShardUsers(shard.id)
						});
					});
					if (process.send) process.send({op: "collectStats", stats: {
						guilds: this.client.guilds.size,
						users: this.client.guilds.reduce((acc, guild) => acc + guild.memberCount, 0),
						uptime: this.client.uptime,
						voice: this.client.voiceConnections.size,
						largeGuilds: this.client.guilds.filter(g => g.large).length,
						shardStats: shardStats,
						ram: process.memoryUsage().rss / 1024 / 1024
					}});

					break;
				}
				case "shutdown": {
					this.shutdown = true;
					if (this.app) {
						if (this.app.shutdown) {
							// Ask app to shutdown
							this.app.shutdown(() => {
								this.client.disconnect({reconnect: false});
								if (process.send) process.send({op: "shutdown"});
							});
						} else {
							this.client.disconnect({reconnect: false});
							if (process.send) process.send({op: "shutdown"});
						}
					} else {
						this.client.disconnect({reconnect: false});
						if (process.send) process.send({op: "shutdown"});
					}

					break;
				}
				case "loadCode": {
					this.loadCode();

					break;
				}
				case "apiResponse": {
					ipc.emit(message.UUID, message.data);

					break;
				}
				case "broadcastEval": {
					const { UUID, code } = message;

					const evaled = eval(code);

					if (process.send) process.send({ op: "broadcastEvalReturn", UUID, value: evaled, clusterID: this.clusterID });

					break;
				}
				case "broadcastEvalReturn": {
					ipc.emit(message.UUID, message.value);

					break;
				}
				}
			}
		});

		this.totalShardCount = totalShardCount;
	}

	private async connect() {
		if (this.whatToLog.includes("cluster_start")) {
			console.log('--------------------------------------------------------');
			console.log(`Connecting with ${this.shards} shard(s)`);
			console.log('--------------------------------------------------------');
		}

		const options = Object.assign(this.clientOptions, {autoreconnect: true, firstShardID: this.firstShardID, lastShardID: this.lastShardID, maxShards: this.shardCount});

		const botFile = (await import(this.path));

		let bot;
		if (botFile.App.Eris) {
			bot = new botFile.App.Eris.Client(this.token, { ...options, clusterID: this.clusterID, workerID: worker.id, ipc, totalShardCount: this.totalShardCount });
			botFile.App = botFile.App.BotWorker;
		} else {
			bot = new Eris.Client(this.token, { ...options, clusterID: this.clusterID, workerID: worker.id, ipc, totalShardCount: this.totalShardCount });
			if (botFile.App.BotWorker) {
				botFile.App = botFile.App.BotWorker;
			} else {
				botFile.App = botFile.App.default ? botFile.App.default : botFile.App;
			}
		}

		botFile.loadCommandsAndEvents(bot);

		this.client = bot;
		botFile.client = bot;

		const setStatus = () => {
			if (this.startingStatus) {
				if (this.startingStatus.game) {
					this.client.editStatus(this.startingStatus.status, this.startingStatus.game);
				} else {
					this.client.editStatus(this.startingStatus.status);
				}
			}
		};

		bot.on("connect", (id: number) => {
			if (this.whatToLog.includes("shard_connect")) {
                console.log('--------------------------------------------------------');
                console.log(`[Shards]\tLaunched Shard ${id}`);
			}
		});

		bot.on("shardDisconnect", (err: Error, id: number) => {
			if (!this.shutdown) if (this.whatToLog.includes("shard_disconnect")) console.log(`Shard ${id} disconnected with error: ${inspect(err)}`);

			botFile.updateShardStatus(id);
		});

		bot.once("shardReady", () => {
			setStatus();
		});

		bot.on("shardReady", (id: number) => {
			if (this.whatToLog.includes("shard_ready")) console.log(`Shard ${id} is ready!`);

			botFile.updateShardStatus(id);
		});

		bot.on("shardResume", (id: number) => {
			if (this.whatToLog.includes("shard_resume")) console.log(`Shard ${id} has resumed!`);

			botFile.updateShardStatus(id);
		});

		bot.on("warn", (message: string, id: number) => {
			if (process.send) process.send({op: "warn", msg: message, source: `Cluster ${this.clusterID}, Shard ${id}`});
		});

		bot.on("error", (error: Error, id: number) => {
			if (process.send) process.send({op: "error", msg: inspect(error), source: `Cluster ${this.clusterID}, Shard ${id}`});
		});

		bot.on("ready", () => {
			if (this.whatToLog.includes("cluster_ready")) {
                console.log('--------------------------------------------------------');
				console.log(`Shards ${this.firstShardID} - ${this.lastShardID} are ready!`);
			}
		});

		bot.once("ready", () => {
			this.App = botFile.App;
			if (process.send) process.send({op: "connected"});
		});

		// Connects the bot
		bot.connect();
	}

	
	private async loadCode() {
		//let App = (await import(this.path)).default;
		//App = App.default ? App.default : App;
		this.app = new this.App({bot: this.client, clusterID: this.clusterID, workerID: worker.id, ipc});
	}
}