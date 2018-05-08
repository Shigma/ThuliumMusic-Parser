const TmError = require('./Error')

class PitchParser {
  constructor({
    Pitch,
    PitOp = '',
    Chord = '',
    VolOp = ''
  }, library, settings, pitchQueue) {
    this.Pitch = Pitch
    this.PitOp = PitOp
    this.Chord = Chord
    this.VolOp = VolOp
    this.Library = library
    this.Settings = settings
    this.PitchQueue = pitchQueue
    this.Warnings = []
  }

  parse() {
    this.parsePitch()
    this.parsePitVol()
    this.parseChord()
    return this.Result
  }

  parsePitch() {
    if (this.Pitch instanceof Array) {
      this.Result = [].concat(...this.Pitch.map(pitch => {
        return new PitchParser(pitch, this.Library, this.Settings).parse()
      }))
    } else {
      if (this.Library.Pitch[this.Pitch] !== undefined) {
        this.Result = this.Library.Pitch[this.Pitch]
        this.Result.forEach(note => {
          if (note.Volume === undefined) note.Volume = 1
          note.Volume *= this.Settings.Volume
        })
        if ('1' <= this.Pitch && this.Pitch <= '9') {
          this.Result.forEach(note => {
            note.Fixed = false
            note.Pitch += this.Settings.Key
          })
        } else {
          this.Result.forEach(note => {
            note.Fixed = true
          })
        }
      } else if (this.Pitch === '%') {
        if (this.PitchQueue.length >= this.Settings.Trace) {
          this.Result = this.PitchQueue[this.PitchQueue.length - this.Settings.Trace]
        } else {
          this.Result = []
          this.reportError('Note::NoPrevious', { Trace: this.Settings.Trace })
        }
      }
    }
  }

  parsePitVol() {
    const delta = this.PitOp.split('').reduce((sum, op) => {
      return sum + { '#': 1, 'b': -1, '\'': 12, ',': -12 }[op]
    }, 0)
    const scale = this.VolOp.split('').reduce((prod, op) => {
      return prod * (op === '>' ? this.Settings.Accent : this.Settings.Light)
    }, 1)
    this.Result.forEach(note => {
      note.Volume *= scale
      if (!note.Fixed) {
        note.Pitch += delta
      }
    })
  }

  parseChord() {
    this.Result = this.Chord.split('').reduce((notes, op) => {
      const chord = this.Library.Chord[op]
      const result = []
      const length = notes.length
      const used = new Array(length).fill(false)
      let flag = true
      chord.forEach(([head, tail, delta]) => {
        if (!flag) return
        if (head < -length || head >= length || tail < -length || tail >= length) {
          this.reportError('Note::ChordRange', { Length: length, Head: head, Tail: tail })
          return flag = false
        }
        if (head < 0) head += length
        if (tail < 0) tail += length
        if (head > tail) {
          this.reportError('Note::ChordRange', { Length: length, Head: head, Tail: tail })
          return flag = false
        }
        for (let i = head; i <= tail; i++) used[i] = true
        const interval = notes.slice(head, tail + 1).map(obj => Object.assign({}, obj))
        interval.forEach(note => {
          if (!note.Fixed) note.Pitch += delta
        })
        if (interval.some(note => note.Fixed)) {
          this.reportError('Note::OnFixedNote', { Chord: op, Notes: interval })
          return flag = false
        }
        result.push(...interval)
      })
      if (used.some(item => !item)) {
        this.reportError('Note::UnusedNote', { Chord: op, Notes: notes })
      }
      if (flag) {
        return result
      } else {
        return notes
      }
    }, this.Result)
  }

  reportError(type, args = {}) {
    this.Warnings.push(new TmError(type, {}, args))
  }

  static checkDuplicate(result) {
    const length = result.length
    let i = -1
    while (i++ < length) {
      for (let j = i + 1; j < length; ++j) {
        if (result[i].Pitch === result[j].Pitch) return true
      }
    }
    return false
  }

  static checkVolume(result) {
    let flag = false
    result.forEach(note => {
      if (note.Volume > 1) {
        note.Volume = 1
        flag = true
      }
    })
    return flag
  }

  checkParse() {
    Object.defineProperties(this.parse(), {
      Pitches: { get: function() {
        return this.map(note => note.Pitch)
      }},
      Volumes: { get: function() {
        return this.map(note => note.Volume)
      }}
    })
    if (PitchParser.checkDuplicate(this.Result)) {
      this.reportError('Note::Reduplicate', { Pitches: this.Result.Pitches })
    }
    if (PitchParser.checkVolume(this.Result)) {
      this.reportError('Note::VolumeRange', { Volumes: this.Result.Volumes })
    }
    return this.Result
  }
}

// console.log(new PitchParser({
//   Pitch: [
//     {
//       Pitch: 1,
//       Chord: 'mi'
//     },
//     {
//       Pitch: 3,
//       VolOp: '>>:'
//     }
//   ],
//   PitOp: '##'
// }, {
//   Pitch: {
//     1: [{ Pitch: 0 }],
//     2: [{ Pitch: 2 }],
//     3: [{ Pitch: 4 }],
//     4: [{ Pitch: 5 }],
//     5: [{ Pitch: 7 }],
//     6: [{ Pitch: 9 }],
//     7: [{ Pitch: 11 }]
//   },
//   Chord: {
//     'm': [[0, 0, 0], [0, 0, 3], [0, 0, 7]],
//     'i': [[1, -1, 0], [0, 0, 12]]
//   }
// }, {
//   Key: -2,
//   Volume: 1,
//   Light: 1/2,
//   Accent: 0.8
// }, {
//   BarCount: 0,
//   PitchQueue: []
// }).checkParse())

class NoteParser {
  constructor(note, library, settings, meta) {
    this.Source = note
    this.Stac = note.Stac
    this.DurOp = note.DurOp
    this.Library = library
    this.Settings = settings
    this.Meta = meta
    this.Warnings = []
    this.Position = {
      Bar: this.Meta.BarCount,
      Index: this.Meta.Index
    }
    this.Result = new PitchParser(note, library, settings, meta.PitchQueue).checkParse()
  }

  reportError(type, args = {}) {
    this.Warnings.push(new TmError(type, this.Position, args))
  }

  mergeError(errors) {
    errors.forEach(err => err.pos = this.Position)
    this.Warnings.push(...errors)
  }

  parse() {
    const beat = this.parseBeat(note)
    const duration = beat * 60 / this.Settings.Speed
    const scale = 1 - this.Settings.Stac[this.Stac]

    this.Meta.PitchQueue.push(this.Result.map())

    const result = []
    const notesBeforeTie = []
    // merge pitches with previous ones if tie exists
    if (this.Meta.TieLeft) {
      this.Meta.TieLeft = false
      this.Meta.NotesBeforeTie.forEach((prevNote) => {
        const index = pitches.indexOf(prevNote.Pitch)
        if (index === -1 || prevNote.Volume !== volumes[index]) return
        notesBeforeTie.push(prevNote)
        prevNote.__oriDur += actualDuration
        prevNote.Duration = prevNote.__oriDur
        pitches.splice(index, 1)
        volumes.splice(index, 1)
      })
    }
    for (var index = 0, length = pitches.length; index < length; index++) {
      result.push({
        Type: 'Note',
        Pitch: pitches[index],
        Volume: volumes[index],
        Duration: actualDuration,
        __oriDur: duration,
        Beat: beat,
        StartTime: this.Meta.Duration,
        StartBeat: this.Meta.BeatCount
      })
    }
    this.Meta.NotesBeforeTie = notesBeforeTie.concat(result)
    this.Meta.Duration += duration
    this.Meta.BeatCount += beat
    return {
      Notes: result,
      Beat: beat,
      Warnings: this.Warnings
    }
  }

  parseBeat() {
    let beat = 1
    let pointer = 0
    const length = this.DurOp.length
    while (pointer < length) {
      const char = this.DurOp.charAt(pointer)
      pointer += 1
      switch (char) {
      case '=':
        beat /= 4
        break
      case '-':
        beat += 1
        break
      case '_':
        beat /= 2
        break
      case '.':
        let dotCount = 1
        while (this.DurOp.charAt(pointer) === '.') {
          dotCount += 1
          pointer += 1
        }
        beat *= 2 - Math.pow(2, -dotCount)
        break
      }
    }
    return beat * Math.pow(2, -this.Settings.Duration)
  }
}

NoteParser.pitchDict = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11 }
NoteParser.pitchOperatorDict = { '#': 1, 'b': -1, '\'': 12, ',': -12 }

module.exports = { NoteParser, PitchParser }
