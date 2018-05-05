const { SubtrackParser } = require('./TrackParser')
const TmSetting = require('./Setting')

const methodTypes = [
  'proGlobal',
  'proMerge',
  'epiNote',
  'epiTrack'
]

class TmLoader {
  /**
   * Tm Library Loader
   * @param {Tm.Syntax} Thulium Syntax Object
   */
  constructor(syntax) {
    this.Chord = TmLoader.loadChord(syntax.Chord)
    this.Plugin = TmLoader.loadPlugin(syntax.Class)
    this.Package = new TmPackage(syntax.Code, syntax.Dict)
    this.Track = {}
  }

  static loadChord(dict) {
    const result = {}
    dict.forEach(chord => {
      result[chord.Notation] = chord.Pitches
    })
    return result
  }

  static loadPlugin(plugins) {
    const result = {}
    methodTypes.forEach(method => {
      const candicates = [];
      plugins.forEach(plugin => {
        if (method in plugin) {
          candicates.push(plugin[method])
        }
      })
      result[method] = function() {
        candicates.forEach(func => func(...arguments))
      }
    })
    return result
  }
}

class TmPackage {
  constructor(source, dict) {
    /* eslint-disable-next-line no-new-func */
    this.Dict = new Function(`${source}
      return {${dict.map(func => func.Name).join(',')}};
    `)()
  }

  applyFunction(parser, token) {
    const API = new TmAPI(parser, token, this.Dict)
    return this.Dict[token.Name].apply(API, TmPackage.getArguments(token.Args))
  }

  static getArguments(args) {
    return args.map(arg => {
      switch (arg.Type) {
      case 'Number':
      case 'String':
      case 'Array':
        return arg.Content
      case 'Expression':
        // FIXME: using expression parser
        /* eslint-disable-next-line no-eval */
        return eval(arg.Content.replace(/Log2/g, 'Math.log2'))
      default:
        return {
          Type: 'Subtrack',
          Content: [arg]
        }
      }
    })
  }
}

const Protocols = {
  Default: {
    Read: ['PitchQueue'],
    Write: ['PitchQueue']
  }
}

const NativeMethods = [
  'mergeMeta',
  'isLegalBar'
]

class TmAPI {
  /**
   * Thulium API
   * @param {TmParser} Thulium Parser Object
   * @param {TmToken} Function Token
   * @param {TmPackageDict} Map of Functions
   */
  constructor(parser, token, dict) {
    Object.assign(this, parser)
    this.Token = token
    this.Library = new Proxy({}, {
      get: (_, name) => dict[name]
    })
    for (const method of NativeMethods) {
      this[method] = parser[method]
    }
  }

  newSettings(settings = {}) {
    return new TmSetting(settings)
  }

  ParseTrack(track, { Protocol = 'Default', Settings = null } = {}) {
    if (track === undefined) {
      track = { Type: 'Subtrack', Content: [] }
    }
    return new SubtrackParser(
      track,
      Settings === null ? this.Settings : this.Settings.extend(Settings),
      this.Libraries,
      TmAPI.wrap(this.Meta, Protocol)
    ).parseTrack()
  }

  ReportError(name, args) {
    if (!name.includes('::')) {
      name = 'Func::' + this.Token.Name + '::' + name
    }
    this.pushError(name, args)
  }

  JoinTrack(src1, ...rest) {
    const result = {
      Meta: Object.assign(src1.Meta),
      Content: src1.Content.slice(),
      Warnings: src1.Warnings.slice(),
      Settings: this.Settings,
      pushError: this.pushError,
      isLegalBar: this.isLegalBar
    }
    for (let src of rest) {
      result.Content.push(...src.Content.map(note => {
        return Object.assign({}, note, {
          StartTime: note.StartTime + result.Meta.Duration
        })
      }))
      this.mergeMeta(result, src)
    };
    return result
  }

  static wrap(meta, protocol) {
    const protocolList = Protocols[protocol]
    return new Proxy(meta, {
      get(obj, prop) {
        if (protocolList.Read.includes(prop)) {
          return obj[prop]
        }
        return null
      },
      set(obj, prop, val) {
        if (protocolList.Write.includes(prop)) {
          obj[prop] = val
        }
      }
    })
  }
}

module.exports = TmLoader
