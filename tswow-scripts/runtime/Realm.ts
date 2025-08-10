import { commands } from "../util/Commands";
import { ConfigFile, patchTCConfig, Property, Section } from "../util/ConfigFile";
import { EmulatorCore } from "../util/EmulatorCore";
import { wfs } from "../util/FileSystem";
import { ipaths } from "../util/Paths";
import { isWindows } from "../util/Platform";
import { Process } from "../util/Process";
import { wsys } from "../util/System";
import { term } from "../util/Terminal";
import { termCustom } from "../util/TerminalCategories";
import { CreateCommand, ListCommand, StartCommand, StopCommand } from "./CommandActions";
import { Identifier } from "./Identifiers";
import { Module, ModuleEndpoint } from "./Modules";
import { Connection, mysql } from "./MySQL";
import { NodeConfig } from "./NodeConfig";

const REALM_NAME_FIELD = 'Realm.Name'
export class RealmConfig extends ConfigFile {
    protected description(): string {
        return "Realm Configuration"
    }

    constructor(filename: string, name: string) {
        super(filename);
        if(this.RealmName.length === 0) {
            patchTCConfig(this.filename,REALM_NAME_FIELD,name);
        }
    }

    @Section("Realm")
    @Property({
          name: 'Realm.Dataset'
        , description: 'What dataset to use for this realm'
        , examples: [
            ['default.dataset','']
        ]
        , note: 'The first part of the path is a module id, '
              + 'and the last is a dataset id'
    })
    private _Dataset: string = this.undefined()
    get Dataset() {
        return Identifier.getDataset(this._Dataset);
    }

    @Property({
          name: REALM_NAME_FIELD
        , description: 'The displayed name of this realm'
        , examples: [
            ['TSWoW Realm','']
        ]
    })
    RealmName: string = this.undefined();

    @Property({
        name: 'Realm.PublicAddress'
      , description: 'The public IP of this realm'
      , examples: [
            ['127.0.0.1','Localhost']
          , ['192.168.0.5','Local area network']
          , ['17.5.7.8','Public IP (google "what is my ip" for yours)']
      ]
      , important: 'This is **not** a hostname/DNS'
    })
    PublicAddress: string = this.undefined();

    @Property({
        name: 'Realm.CharactersDB'
      , description: 'The characters db connection string for this realm'
      , examples: [
            ['localhost;3306;root;root', '']
      ]
    })
    CharactersDB: string = this.undefined();

    @Property({
          name: 'Realm.LocalAddress'
        , description: 'The local address of this realm'
        , examples: [
              ['127.0.0.1','Localhost']
            , ['25.4.23.9','Hamachi IP']
        ]
        , important: 'If using reverse tunnelling or a VPN,'
            + 'this must be the IP your friends connect to, not localhost'
    })
    LocalAddress: string = this.undefined()

    @Property({
          name: 'Realm.LocalSubnetMask'
        , description: 'The subnet mask of the local address'
        , examples: [
            ['255.0.0.0','Localhost subnet mask']
        ]
        , important: 'Must match the IP in Realm.LocalAddress'
    })
    LocalSubnetMask: string = this.undefined()

    @Property({
          name: 'Realm.Type'
        , description: 'The type of realm'
        , examples: [
              [0,'PvE']
            , [4,'PvP']
            , [6,'RP']
            , [8,'RP PvP']
        ]
    })
    Type: number = this.undefined()

    @Property({
        name: 'Realm.RequiredSecurityLevel'
      , description: 'What type of account is required to log in to this realm'
      , examples: [
            [0,'Any account']
          , [1,'Moderators']
          , [2,'GM']
          , [3,'Super GM']
      ]
    })
    RequiredSecurityLevel: number = this.undefined()

    @Property({
          name: 'Realm.Recommended'
        , description: 'Whether to list this realm as "Recommended"'
        , examples: [[true,'']]
    })
    Recommended: boolean = this.undefined()

    @Property({
        name: 'Realm.Full'
      , description: 'Whether to list this realm as "Full"'
      , examples: [[true,'']]
    })
    Full: boolean = this.undefined()

    @Property({
        name: 'Realm.Offline'
      , description: 'Whether to list this realm as "Offline"'
      , examples: [[true,'']]
    })
    Offline: boolean = this.undefined()

    @Property({
        name: 'Realm.NewPlayers'
      , description: 'Whether to list this realm as "New Players"'
      , examples: [[true,'']]
    })
    NewPlayers: boolean = this.undefined()

    @Property({
          name: 'Timezone'
        , description: 'The realm timezone, specifies what realmlist tab to use'
        , examples: [[1,'Development']]
        , note: 'See possible values here: https://trinitycore.atlassian.net/wiki/spaces/tc/pages/2130016/realmlist#realmlist-timezone'
    })
    TimeZone: number = this.undefined()

    @Property({
          name: 'Realm.AutoRestart'
        , description: 'Whether to restart the worldserver if it crashes'
        , examples: [[false,'']]
        , note: 'See possible values here: https://trinitycore.atlassian.net/wiki/spaces/tc/pages/2130016/realmlist#realmlist-timezone'
    })
    AutoRestart: boolean = this.undefined();
}

class RealmManager {
    characters: Connection;
    worldserver: Process;
    constructor(name: string, chars_db: string) {
        const makeSettings = (str: string, suffix?: string)=>{
            const [host,port,user,password] = str.split(';')

            name = name
                ? `${name.replace('.', '_')}_`
                : ''
            return {
                  host
                , port : parseInt(port)
                , user
                , password
                , database:`${name}${suffix}`,
            }
        }

        this.characters = new Connection(
              makeSettings(chars_db, 'characters')
            , 'characters'
        )
        this.worldserver = new Process(`realm/${name}`)
            .showOutput(true)
            .onFail(err=>{
                term.error(termCustom('realm',name),err.message)
            })
    }
}

export class Realm {
    private static managers: {[key: string]: RealmManager} = {};

    readonly mod: ModuleEndpoint
    readonly name: string
    lastBuildType: string = NodeConfig.DefaultBuildType
    readonly config: RealmConfig
    private curBuildType?: string

    private manager() {
        let realm = Realm.managers[this.fullName]
        if (realm) {
            return realm;
        }
        realm = Realm.managers[this.fullName] = new RealmManager(this.fullName, this.config.CharactersDB)
        realm.worldserver.onExit(async () => {
            const dateObj = new Date()
            const dateStr = `${dateObj.getFullYear()}-${dateObj.getMonth()+1}-${dateObj.getDate()}.`
                + `${dateObj.getHours()}-${dateObj.getMinutes()}-${dateObj.getSeconds()}`

            term.log(this.logName(), `Worldserver exited`)
            if (!isWindows()) {
                // tracy hackfix, try block because process can be closed already, and process class is broken with this
                try {
                    wsys.exec(`kill -9 ${this.worldserver.lastPID}`)
                } catch (e) {

                }

                const corePath = this.path.join('core').abs()
                if (corePath.exists()) {
                    const tcDir = ipaths.bin.core.pick(`TrinityCore`).build.pick(this.curBuildType)
                    const livescriptLibDir = this.config.Dataset.path.join('lib').join(this.curBuildType)
                    const stackTracePath = this.path.join(`stacktrace-${dateStr}.txt`).abs()
                    term.log(this.logName(), `Found core, generating stacktrace ${stackTracePath.basename().get()}`)
                    await wsys.execAsync(`gdb -batch -ex "set solib-search-path ${tcDir.abs().get()}:${livescriptLibDir.abs().get()}" -ex bt -ex quit ${tcDir.worldserver.abs().get()} ${corePath.abs().get()} > ${stackTracePath.get()}`)
                    const coreCopyPath = corePath.dirname().join(`core-${dateStr}`)
                    term.log(this.logName(), `Wrote core to ${coreCopyPath.get()}`)
                    corePath.copy(coreCopyPath)

                    // removed so that next crash doesn't accidentally use the last core dump
                    corePath.remove()

                    this.path.readDir('ABSOLUTE').filter(x => x.basename().startsWith(`core-`)).sort().slice(NodeConfig.CoresKept)
                        .forEach(x => x.remove())

                    this.path.readDir('ABSOLUTE').filter(x => x.basename().startsWith(`stacktrace-`)).sort().slice(NodeConfig.StackTracesKept)
                        .forEach(x => x.remove())
                } else {
                    term.log(this.logName(), `No core was found`)
                }
            }

            const logPath = this.path.join(`Server.log`)
            const gmLogPath = this.path.join(`GM.log`)
            const dbErrorsPath = this.path.join(`DBErrors.log`)

            ;[logPath, gmLogPath, dbErrorsPath].forEach(x => {
                if (!x.exists()) {
                    return;
                }

                const filename = x.basename().get().replace('.log', '')
                const copyPath = this.path.join(`${filename}-${dateStr}.log`)
                x.copy(copyPath)
            })
            this.path.readDir('ABSOLUTE').filter(x => x.basename().startsWith(`Server-`) && x.endsWith(`.log`)).sort().slice(NodeConfig.LogsKept)
                .forEach(x => x.remove())
            this.path.readDir('ABSOLUTE').filter(x => x.basename().startsWith(`GM-`) && x.endsWith(`.log`)).sort().slice(NodeConfig.LogsKept)
                .forEach(x => x.remove())
            this.path.readDir('ABSOLUTE').filter(x => x.basename().startsWith(`DBErrors-`) && x.endsWith(`.log`)).sort().slice(NodeConfig.LogsKept)
                .forEach(x => x.remove())
            this.path.readDir('ABSOLUTE').filter(x => x.basename().startsWith(`anticheat_`) && x.endsWith(`.log`)).sort().slice(NodeConfig.LogsKept)
                .forEach(x => x.remove())
        })

        return realm
    }

    get characters() {
        return this.manager().characters;
    }

    get worldserver() {
        return this.manager().worldserver;
    }

    get fullName() {
        return this.mod.fullName+'.'+this.name;
    }

    get path() {
        if(this._path) return this._path;
        return ( this._path as any) = this.mod.path.realms.realm.pick(this.name);
    }
    private _path: never;

    hasID() {
        return this.path.realm_id.exists()
    }

    getID() {
        if(this.path.realm_id.exists()) {
            return parseInt(this.path.realm_id.readString())
        }
        let used: {[key: string]: boolean} = {}
        Realm.all().forEach(x=>{
            if(x.hasID()) {
                used[x.getID()] = true;
            }
        })
        let i = 1;
        while(used[i] !== undefined) ++i;
        this.path.realm_id.write(`${i}`);
        return i;
    }

    realmlistSQL() {
        let flag = 0;
        if(this.config.Offline) flag |=0x2
        if(this.config.NewPlayers) flag |= 0x10;
        if(this.config.Recommended) flag |= 0x20;
        if(this.config.Full) flag |= 0x40

        let port: number;
        if(!this.path.worldserver_conf.exists()) {
            port = 8085;
        } else {
            let portMatch = this.path.worldserver_conf.readString()
                .match(/WorldServerPort *= *(\d+)/)
            if(portMatch) {
                port = parseInt(portMatch[1]);
            }
        }

        let values = [
            ['id',this.getID()],
            ['name',`"${this.config.RealmName}"`],
            ['address',`"${this.config.PublicAddress}"`],
            ['localAddress',`"${this.config.LocalAddress}"`],
            ['localSubnetMask',`"${this.config.LocalSubnetMask}"`],
            ['port',port],
            ['icon',this.config.Type],
            ['flag',flag],
            ['timezone', this.config.TimeZone],
            ['allowedSecurityLevel', this.config.RequiredSecurityLevel],
            ['population', 0],
            ['game_build', this.config.Dataset.config.DatasetGameBuild ]
        ]

        return (
            `INSERT INTO realmlist VALUES (${values.map(x=>x[1])
                .join(',')});`
        );
    }

    constructor(mod: ModuleEndpoint, name: string) {
        this.mod = mod;
        this.name = name;
        this.config = new RealmConfig(this.path.config.get(),name)
    }

    logName() {
        return termCustom('realm',this.fullName)
    }

    get core(): EmulatorCore {  return this.config.Dataset.config.EmulatorCore }

    async start(type: string, force: boolean = false) {
        this.curBuildType = type;
        term.log(this.logName(),`Starting worlserver for ${this.config.RealmName}...`)
        this.lastBuildType = type;
        await this.connect();
        await this.config.Dataset.setupDatabases('BOTH',false);
        await this.config.Dataset.setupClientData()
        this.config.Dataset.writeModulesTxt()

        // Generate .conf files
        ipaths.bin.core.pick(this.config.Dataset.config.EmulatorCore).build.pick(type)
            .iterate('FLAT','FILES','FULL',node=>{
                if(!node.endsWith('.conf.dist')) return;
                if(node.endsWith('authserver.conf.dist')) {
                    return;
                }
                const fname = node.basename()
                node.copy(this.path.join(fname))
                node.copyOnNoTarget(this.path.join(fname.substring(0,fname.length-'.dist'.length)))
            });

        patchTCConfig(
              this.path.worldserver_conf.get()
            , 'LoginDatabaseInfo'
            , NodeConfig.DatabaseString('auth')
        )

        const makeSettings = (str: string, suffix?: string)=>{
            const [host,port,user,password] = str.split(';')

            return {
                  host
                , port : parseInt(port)
                , user
                , password
                , database: this.characters.cfg.database,
            }
        }

        patchTCConfig(
            this.path.worldserver_conf.get()
          , 'CharacterDatabaseInfo'
          , (
            () => {
                let settings = makeSettings(this.config.CharactersDB, 'characters');
                return `${settings.host};${settings.port};${settings.user};${settings.password};${settings.database}`;
                }
            )()
        )

        patchTCConfig(
            this.path.worldserver_conf.get()
          , 'WorldDatabaseInfo'
          , NodeConfig.DatabaseString('world',this.config.Dataset.fullName)
        )

        patchTCConfig(
              this.path.worldserver_conf.get()
            , 'MySQLExecutable'
            , NodeConfig.MySQLExecutable.length === 0
                ? ipaths.bin.mysql.mysql_exe.abs().get()
                : '"NodeConfig.MySQLExecutable"'
        )

        if(this.core === 'trinitycore') {
            patchTCConfig(this.path.worldserver_conf.get(), 'HotSwap.Enabled',1)
            patchTCConfig(this.path.worldserver_conf.get(), 'HotSwap.EnableReCompiler',0)
            patchTCConfig(this.path.worldserver_conf.get(), 'HotSwap.EnableEarlyTermination',0)
            patchTCConfig(this.path.worldserver_conf.get(), 'HotSwap.EnableBuildFileRecreation',0)
            patchTCConfig(this.path.worldserver_conf.get(), 'HotSwap.EnableInstall',0)
            patchTCConfig(this.path.worldserver_conf.get(), 'HotSwap.EnablePrefixCorrection',0)
        }

        patchTCConfig(this.path.worldserver_conf.get(), 'Updates.EnableDatabases', 0)
        patchTCConfig(this.path.worldserver_conf.get(), 'Updates.AutoSetup', 0)
        patchTCConfig(this.path.worldserver_conf.get(), 'Updates.Redundancy', 0)
        patchTCConfig(this.path.worldserver_conf.get(), 'RealmID',this.getID())
        patchTCConfig(this.path.worldserver_conf.get(), 'DataDir',this.config.Dataset.path.abs().get())

        this.worldserver.setAutoRestart(this.config.AutoRestart);

        if (!isWindows()) {
            wsys.exec(`ulimit -c ${NodeConfig.CoreDumpSize}`)
            // todo: should check what core is instead
            try {
                wsys.exec(`echo "core" | sudo tee /proc/sys/kernel/core_pattern`)
            } catch(e) {
                term.error(this.logName(), `Failed to set core pattern, core dumps could not work`)
            }
            wsys.exec(`export ASAN_OPTIONS=${NodeConfig.AsanOptions}`)
        }

        switch(this.core) {
            case 'trinitycore':
                this.worldserver.startIn(this.path.get(),
                    wfs.absPath(ipaths.bin.core.pick(this.config.Dataset.config.EmulatorCore).build.pick(type).worldserver.get()),
                        [`-c${wfs.absPath(this.path.worldserver_conf.get())}`], force);
                break;
        }
    }

    async connect() {
        term.debug(this.logName(), `Connecting to ${this.name} databases`)
        await this.characters.connect()
        await this.config.Dataset.connect();
        await mysql.installCharacters(this.characters,this.core);
    }

    sendWorldserverCommand(command: string, useNewline: boolean = true) {
        if(this.worldserver.isRunning()) {
            this.worldserver.send(command,useNewline);
        }
    }

    initialize() {
        try {
            ipaths.bin.core.pick(this.config.Dataset.config.EmulatorCore).build.pick(NodeConfig.DefaultBuildType)
                .worldserver_conf_dist.copy(this.path.worldserver_conf_dist)
            this.path.worldserver_conf_dist
                .copyOnNoTarget(this.path.worldserver_conf)
            this.config.generateIfNotExists()
        } catch(err) {
            term.error(this.logName(),`Error during intialization: ${err.message}`)
        }
        return this;
    }

    static create(mod: ModuleEndpoint, name: string, displayname: string = name) {
        let existed = new Realm(mod,name).path.config.exists()
        const realm = new Realm(mod, name).initialize();
        if(!existed) {
            patchTCConfig(realm.config.filename,REALM_NAME_FIELD,displayname);
        }
        return realm;
    }

    static all() {
        return Module.endpoints()
            .filter(x=>x.path.realms.exists())
            .reduce<Realm[]>((p,c)=>p.concat(c.realms.all()),[])
    }

    static async initialize() {
        term.debug('misc', `Initializing realms`)
        // Create default realm if it's selected
        if(NodeConfig.DefaultRealm === 'default.realm') {
            ipaths.modules.join('default/realms/realm').mkdir()
        }

        if(
               !process.argv.includes('noac')
            && !process.argv.includes('norealm')
        ) {
            await Promise.all(NodeConfig.AutoStartRealms
                .map(x=>Identifier.getRealm(x)
                    .start(NodeConfig.DefaultBuildType)))
        }

        StopCommand.addCommand(
              'realm'
            , 'relamnames time --force'
            , 'Shuts down the specified realms. If the --force flag is supplied, time is ignored.'
            , args => {
                let delay = args.map(x=>parseInt(x)).find(x=>!Number.isNaN(x)) || 0
                let realms = Identifier.getRealms(
                        args
                    , 'MATCH_ANY'
                    , NodeConfig.DefaultRealm
                )

                let runningRealms = realms.filter(x=>x.worldserver.isRunning())
                if(runningRealms.length === 0) {
                    throw new Error(`None of the specified realms are started: ${realms.map(x=>x.fullName).join(' ')}`)
                }

                return Promise.all(runningRealms.map(x=>{
                    if(args.includes('--disable-auto-restart')) {
                        x.worldserver.setAutoRestart(false);
                    }else if(args.includes('--enable-auto-restart'))
                    {
                        x.worldserver.setAutoRestart(true);
                    }

                    if(args.includes('--force')) {
                        return x.worldserver.stop();
                    } else {
                        x.worldserver.send(`server shutdown force ${delay}`)
                        return x.worldserver.stopPromise()
                    }
                }))
            }
        )

        CreateCommand.addCommand(
              'realm'
            , 'module realmname displayname?'
            , ''
            , args => {
                const module = Identifier.getModule(args[0])
                const realmname = Identifier.assertUnused(args[1],'realmname');
                const displayname = args[2];
                this.create(module,realmname,displayname);
            }
        ).addAlias('realms')

        StartCommand.addCommand(
              'realm'
            , ''
            , ''
            , async args => {
                await Promise.all(Identifier.getRealms(args,'MATCH_ANY',NodeConfig.DefaultRealm)
                    .map(x=>{
                        if(args.includes('--disable-auto-restart')) {
                            x.worldserver.setAutoRestart(false);
                        } else if(args.includes('--enable-auto-restart')) {
                            x.worldserver.setAutoRestart(true);
                        }

                        return x.start(Identifier.getBuildType(args,NodeConfig.DefaultBuildType).Name, args.includes('force'))
                    }))
            }
        ).addAlias('realms')

        commands.addCommand('realm')
            .addCommand('send','','',args=>{
                let realm = Identifier.getRealm(args[0]);
                let message = args.slice(1);
                realm.worldserver.send(message.join(' '),true);
            });

        ListCommand.addCommand(
              'realm'
            , ''
            , ''
            , args => {
                let isModule = Identifier.isModule(args[0])
                Realm.all()
                    .sort((a,b)=>{
                        let ar = a.worldserver.isRunning();
                        let br = b.worldserver.isRunning();
                        return ar === br ? 0 : ar ? 1 : -1;
                    })
                    .filter(x=> !isModule || x.mod.mod.id === args[0])
                    .forEach(x=>{
                        if(x.worldserver.isRunning()) {
                            term.success('realm',x.name+': '+x.path.get()+' (running)')
                        } else {
                            term.error('realm',x.name+': '+x.path.get()+' (not running)')
                        }
                    })
          }
        ).addAlias('realms')

        CreateCommand.addCommand(
              'account'
            , 'accountName password gmLevel=0 (3 is highest)'
            , 'Creates a new account for the specified realm'
            , async args => {
                if(args.length < 2) {
                    throw new Error(`This command requires at least an account name and password.`)
                }
                const username = args[0].toUpperCase();
                const password = args[1].toUpperCase();
                const gmlevel = parseInt(args[2]||'0')

                for(const realm of Realm.all()) {
                    if(realm.worldserver.isRunning()) {
                        // hackfix: this doesn't work if the
                        // worldserver is currently starting.
                        realm.sendWorldserverCommand(
                            `account create ${username} ${password}`
                        )
                        await wsys.sleep(500);
                        realm.sendWorldserverCommand(
                            `account set gmlevel ${username} ${gmlevel} -1`
                        )
                        return;
                    }
                }
                throw new Error(
                        `No worldserver found.`
                    + ` The 'create account' command only currently works`
                    + ` if at least one worldserver is running.`
                )
            }
        )
    }
}

export class Realms {
    readonly mod: ModuleEndpoint;

    get path() {
        return this.mod.path.realms
    }

    constructor(mod: ModuleEndpoint) {
        this.mod = mod;
    }

    pick(name: string) {
        return new Realm(this.mod,this.path.realm.pick(name).get())
    }

    all() {
        return this.path.realm.all()
            .map(x=>new Realm(this.mod, x.basename().get()))
    }

    create(name: string) {
        return Realm.create(this.mod,name)
    }
}
