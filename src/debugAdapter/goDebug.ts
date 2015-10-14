/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, Thread, StackFrame, Scope, Source} from './common/debugSession';
import {Handles} from './common/handles';
import {readFileSync} from 'fs';
import {basename, dirname} from 'path';
import {spawn, ChildProcess} from 'child_process';
import {Client, RPCConnection} from 'json-rpc2';
import * as path from 'path';

interface DebuggerState {
	exited: boolean;
	exitStatus: number;
	breakPoint: DebugBreakpoint;
	breakPointInfo: {};
	currentThread: DebugThread;
	currentGoroutine: DebugGoroutine;
}

interface DebugBreakpoint {
	addr: number;
	continue: boolean;
	file: string;
	functionName?: string;
	goroutine: boolean;
	id: number;
	line: number;
	stacktrace: number;
	variables?: DebugVariable[];
}

interface DebugThread {
	file: string;
	id: number;
	line: number;
	pc: number;
	function?: DebugFunction;
};

interface DebugLocation {
	pc: number;
	file: string;
	line: number;
	function: DebugFunction;
}

interface DebugFunction {
	name: string;
	value: number;
	type: number;
	goType: number;
	args: DebugVariable[];
	locals: DebugVariable[];
}

interface DebugVariable {
	name: string;
	value: string;
	type: string;
}

interface DebugGoroutine {
	id: number;
	pc: number;
	file: string;
	line: number;
	function: DebugFunction;
}

interface DebuggerCommand {
	name: string;
	threadID?: number;
	goroutineID?: number;
}

class Delve {
	debugProcess: ChildProcess;
	connection: Promise<RPCConnection>;
	
	constructor(program: string) {
		this.connection = new Promise((resolve, reject) => {
			var serverRunning = false;
			// TODO: Make this more robust.
			var dlv = path.join(process.env["GOPATH"], "bin", "dlv");
			this.debugProcess = spawn(dlv, ['debug',  '--headless=true', '--listen=127.0.0.1:2345', '--log', program], { cwd: dirname(program) });
			
			function connectClient() {
				var client = Client.$create(2345, '127.0.0.1');
				client.connectSocket((err, conn) => {
					if (err) return reject(err);
					resolve(conn);			
				});
			}
			
			this.debugProcess.stderr.on('data', chunk => {
				var str = chunk.toString();
				console.log(str);
				if(!serverRunning) {
					serverRunning = true;
					connectClient();
				}
			});
			this.debugProcess.stdout.on('data', function(chunk) {
				var str = chunk.toString();
				console.log(str);
			});
			this.debugProcess.on('close', function(code) {
				console.error("Process exiting with code: " + code);
			});
		});
	}
	
	call<T>(command: string, args: any[], callback: (err: Error, results: T) => void) {
		this.connection.then(conn => {
			conn.call('RPCServer.' + command, args, callback);
		}, err => {
			callback(err, null);
		});
	}
	
	callPromise<T>(command: string, args: any[]): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.connection.then(conn => {
				conn.call<T>('RPCServer.' + command, args, (err, res) => {
					if(err) return reject(err);
					resolve(res);
				});
			}, err => {
				reject(err);
			});
		});
	}
	
	close() {
		this.debugProcess.kill();	
	}
}

class GoDebugSession extends DebugSession {

	private _variableHandles: Handles<string>;	
	private breakpoints: Map<string, DebugBreakpoint[]>;
	private debugState: DebuggerState;
	private delve: Delve;

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);
		this._variableHandles = new Handles<string>();
		this.debugState = null;
		this.delve = null;
		this.breakpoints = new Map<string, DebugBreakpoint[]>();
	}

	protected initializeRequest(response: OpenDebugProtocol.InitializeResponse, args: OpenDebugProtocol.InitializeRequestArguments): void {
		console.log("InitializeRequest");
		this.sendResponse(response);
		console.log("InitializeResponse")
		this.sendEvent(new InitializedEvent());
		console.log("InitializeEvent");
	}

	protected launchRequest(response: OpenDebugProtocol.LaunchResponse, args: OpenDebugProtocol.LaunchRequestArguments): void {
		// Launch the Delve debugger on the program
		this.delve = new Delve(args.program);
		// TODO: This isn't quite right - may not want to blindly continue on start.
		this.continueRequest(response);
	}
	
	protected disconnectRequest(response: OpenDebugProtocol.DisconnectResponse, args: OpenDebugProtocol.DisconnectArguments): void {
		console.log("DisconnectRequest");
		this.delve.close();
		super.disconnectRequest(response, args);
		console.log("DisconnectResponse");		
	}

	protected setBreakPointsRequest(response: OpenDebugProtocol.SetBreakpointsResponse, args: OpenDebugProtocol.SetBreakpointsArguments): void {
		console.log("SetBreakPointsRequest")
		if(!this.breakpoints.get(args.source.path))  { 
			this.breakpoints.set(args.source.path, []); 
		}
		var file = args.source.path;
		var existingBPs = this.breakpoints.get(file);
		Promise.all(this.breakpoints.get(file).map(existingBP => {
			console.log("Clearing: " + existingBP.id); 
			return this.delve.callPromise<DebugBreakpoint>('ClearBreakpoint', [existingBP.id])
		})).then(() => { 
			console.log("All cleared")
			return Promise.all(args.lines.map(line => {
				console.log("Creating on: " + file + ":" + line); 
				return this.delve.callPromise<DebugBreakpoint>('CreateBreakpoint', [{file, line}]).catch(err => null);
			}))
		}).then(newBreakpoints => {
			console.log("All set:" + JSON.stringify(newBreakpoints));
			var breakpoints = newBreakpoints.map((bp, i) => {
				if(bp) {
					return { verified: true, line: bp.line } 	
				} else {
					return { verified: false, line: args.lines[i] }
				}
			});
			response.body = { breakpoints };
			this.sendResponse(response);
			console.log("SetBreakPointsResponse")
			this.breakpoints.set(args.source.path, newBreakpoints.filter(x => !!x));
		}).catch(err => {
			console.error(err);
		});
	}

	protected threadsRequest(response: OpenDebugProtocol.ThreadsResponse): void {
		console.log("ThreadsRequest")
		this.delve.call<DebugGoroutine[]>('ListGoroutines', [], (err, goroutines) => {
			var threads = goroutines.map(goroutine =>
				new Thread(
					goroutine.id, 
					goroutine.function ? goroutine.function.name : (goroutine.file + "@" + goroutine.line)
				)
			);
			response.body = { threads };
			this.sendResponse(response);
			console.log("ThreadsResponse")
			console.log(threads);
		});
	}

	protected stackTraceRequest(response: OpenDebugProtocol.StackTraceResponse, args: OpenDebugProtocol.StackTraceArguments): void {
		console.log("StackTraceRequest")
		this.delve.call<DebugLocation[]>('StacktraceGoroutine', [{ id: args.threadId, depth: args.levels }], (err, locations) => {
			if(err) {
				console.error("Failed to produce stack trace!")
				return;
			}
			console.log(locations);
			var stackFrames = locations.map((location, i) => 
				new StackFrame(
					i,
					location.function ? location.function.name : "<unknown>",
					new Source(
						basename(location.file),
						this.convertDebuggerPathToClient(location.file)
					),
					location.line,
					0
				)
			);
			response.body = { stackFrames };
			this.sendResponse(response);
			console.log("StackTraceResponse");				
		});
	}

	protected scopesRequest(response: OpenDebugProtocol.ScopesResponse, args: OpenDebugProtocol.ScopesArguments): void {
		console.log("ScopesRequest")
		var scopes = new Array<Scope>();
		// Locals includes both locals and arguments
		scopes.push(new Scope("Local", this._variableHandles.create("local_" + args.frameId), false));
		// TODO: Let user see package vars and thread local package vars.
		//       The former in particular is a very large set of variables.
		//scopes.push(new Scope("Thread", this._variableHandles.create("threadpackage_" + args.frameId), false));
		//scopes.push(new Scope("Package", this._variableHandles.create("package_" + args.frameId), false));
		response.body = { scopes };
		this.sendResponse(response);
		console.log("ScopesResponse")
	}

	protected variablesRequest(response: OpenDebugProtocol.VariablesResponse, args: OpenDebugProtocol.VariablesArguments): void {
		console.log("VariablesRequest");
		var req = this._variableHandles.get(args.variablesReference);
		var parts = req.split('_');
		var kind = parts[0];
		var frame = +parts[1];
		switch(kind) {
			case "local":
				this.delve.call<DebugVariable[]>('ListLocalVars', [{ goroutineID: this.debugState.currentGoroutine.id, frame: frame }], (err, locals) => {	
					console.log(locals);
					this.delve.call<DebugVariable[]>('ListFunctionArgs', [{ goroutineID: this.debugState.currentGoroutine.id, frame: frame }], (err, args) => {
						console.log(args);
						var variables = args.concat(locals).map((v, i) => ({ 
							name: v.name,
							value: v.value,
							variablesReference: 0
						}));
						response.body = { variables };
						this.sendResponse(response);	
						console.log("VariablesResponse");
					});			
				});
				break;
			// case "package":
			// 	this.delve.call<DebugVariable[]>('ListPackageVars', [{ goroutineID: this.debugState.currentGoroutine.id, frame: frame }], (err, vars) => {	
			// 		console.log(vars);
			// 		var variables = vars.map((v, i) => ({ 
			// 			name: v.name,
			// 			value: v.value,
			// 			variablesReference: 0
			// 		}));
			// 		response.body = { variables };
			// 		this.sendResponse(response);	
			// 		console.log("VariablesResponse");			
			// 	});
			// 	break;
			default:
				console.error("Unknown variable request: " + kind);
				response.body = { variables: [] };
				this.sendResponse(response);	
				console.log("VariablesResponse");
		}
	}

	protected continueRequest(response: OpenDebugProtocol.ContinueResponse): void {
		console.log("ContinueRequest")
		this.delve.call<DebuggerState>('Command', [{ name: 'continue' }], (err, state) => {
			console.log(state);
			if(state.exited) {
				this.sendEvent(new TerminatedEvent());	
				console.log("TerminatedEvent");
			} else {
				this.debugState = state;
				this.sendEvent(new StoppedEvent("breakpoint", this.debugState.currentGoroutine.id));
				console.log("StoppedEvent('breakpoint')");
			}
		});
		this.sendResponse(response);
		console.log("ContinueResponse");
	}

	protected nextRequest(response: OpenDebugProtocol.NextResponse): void {
		console.log("NextRequest")
		this.delve.call<DebuggerState>('Command', [{ name: 'next' }], (err, state) => {
			console.log(state);
			if(state.exited) {
				this.sendEvent(new TerminatedEvent());
				console.log("TerminatedEvent");
			} else {
				this.debugState = state;
				this.sendEvent(new StoppedEvent("step", this.debugState.currentGoroutine.id));
				console.log("StoppedEvent('step')");
			}
		});
		this.sendResponse(response);
		console.log("NextResponse")
	}
	
	protected stepInRequest(response: OpenDebugProtocol.StepInResponse) : void {
		//TODO: Step-in doesn't appear to do anything in Delve
		console.log("StepInRequest")
		this.delve.call<DebuggerState>('Command', [{ name: 'step' }], (err, state) => {
			console.log(state);
			if(state.exited) {
				this.sendEvent(new TerminatedEvent());
				console.log("TerminatedEvent");
			} else {
				this.debugState = state;
				this.sendEvent(new StoppedEvent("step", this.debugState.currentGoroutine.id));
				console.log("StoppedEvent('step')");
			}
		});
		this.sendResponse(response);
		console.log("StepInResponse")
	}

	protected stepOutRequest(response: OpenDebugProtocol.StepOutResponse) : void {
		console.error('Not yet implemented: stepOutRequest');
		this.sendResponse(response);
	}
	
	protected pauseRequest(response: OpenDebugProtocol.PauseResponse) : void {
		console.error('Not yet implemented: pauseRequest');
		this.sendResponse(response);
	}

	protected evaluateRequest(response: OpenDebugProtocol.EvaluateResponse, args: OpenDebugProtocol.EvaluateArguments): void {
		console.log("EvaluateRequest");
		response.body = { result: "evaluate(" + args.expression + ")", variablesReference: 0 };
		this.sendResponse(response);
		console.log("EvaluateResponse");
	}
}

DebugSession.run(GoDebugSession);
