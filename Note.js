const TmError = require('./Error')

class PitchParser {
  constructor({ Pitch, PitOp = '', Chord = '', VolOp = '' }, library, settings, pitchQueue = []) {
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
    let result

    // Pitch
    if (this.Pitch instanceof Array) {
      result = [].concat(...this.Pitch.map(pitch => {
        return new PitchParser(pitch, this.Library, this.Settings).parse()
      }))
    } else {
      if (this.Library.Pitch[this.Pitch] !== undefined) {
        result = this.Library.Pitch[this.Pitch]
        result.forEach(note => {
          if (note.Volume === undefined) note.Volume = 1
          note.Volume *= this.Settings.Volume
        })
        if ('1' <= this.Pitch && this.Pitch <= '9') {
          result.forEach(note => {
            note.Fixed = false
            note.Pitch += this.Settings.Key
          })
        } else {
          result.forEach(note => {
            note.Fixed = true
          })
        }
      } else if (this.Pitch === '%') {
        if (this.PitchQueue.length >= this.Settings.Trace) {
          result = this.PitchQueue[this.PitchQueue.length - this.Settings.Trace]
        } else {
          this.warn('Note::NoPrevious', { Trace: this.Settings.Trace })
        }
      }
    }

    // PitOp & VolOp
    const delta = this.PitOp.split('').reduce((sum, op) => {
      return sum + { '#': 1, 'b': -1, '\'': 12, ',': -12 }[op]
    }, 0)
    const scale = this.VolOp.split('').reduce((prod, op) => {
      return prod * (op === '>' ? this.Settings.Accent : this.Settings.Light)
    }, 1)
    result.forEach(note => {
      if (!note.Fixed) {
        note.Pitch += delta
        note.Volume *= scale
      }
    })

    // Chord
    result = this.Chord.split('').reduce((notes, op) => {
      const chord = this.Library.Chord[op]
      const result = []
      const length = notes.length
      const used = new Array(length).fill(false)
      let flag = true
      chord.forEach(([head, tail, delta]) => {
        if (!flag) return
        if (head < -length || head >= length || tail < -length || tail >= length) {
          this.warn('Note::ChordRange', { Length: length, Head: head, Tail: tail })
          return flag = false
        }
        if (head < 0) head += length
        if (tail < 0) tail += length
        if (head > tail) {
          this.warn('Note::ChordRange', { Length: length, Head: head, Tail: tail })
          return flag = false
        }
        for (let i = head; i <= tail; i++) used[i] = true
        const interval = notes.slice(head, tail + 1).map(obj => Object.assign({}, obj))
        interval.forEach(note => {
          if (!note.Fixed) note.Pitch += delta
        })
        if (interval.some(note => note.Fixed)) {
          this.warn('Note::OnFixedNote', { Chord: op, Notes: interval })
          return flag = false
        }
        result.push(...interval)
      })
      if (used.some(item => !item)) {
        this.warn('Note::UnusedNote', { Chord: op, Notes: notes })
      }
      if (flag) {
        return result
      } else {
        return notes
      }
    }, result)

    return result
  }

  warn(type, args) {
    this.Warnings.push(new TmError(type, {
      Bar: this.Meta.BarCount,
      Index: this.Meta.Index
    }, args))
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
//   Accent: 2
// }).parse())

class NoteParser {
  constructor(note, library, settings, meta) {
    this.Meta = meta
    this.Settings = settings
    this.Chord = library.Chord
    this.Dict = library.PitchDict
    this.Epilog = library.Plugin.epiNote
    this.Source = note
    this.Warnings = []
  }

  static isDup(arr) {
    const length = arr.length
    let i = -1
    while (i++ < length) {
      for (let j = i + 1; j < length; ++j) {
        if (arr[i] === arr[j]) return true
      }
    }
    return false
  }

  warn(type, args) {
    this.Warnings.push(new TmError(type, {
      Bar: this.Meta.BarCount,
      Index: this.Meta.Index
    }, args))
  }

  parse() {
    const note = this.Source
    const pitches = []
    const pitchQueue = []
    const volumes = []
    const beat = this.parseBeat(note)
    const duration = beat * 60 / this.Settings.Speed
    const actualDuration = duration * (1 - this.Settings.Stac[note.Stac])

    // calculate pitch array and record it for further trace
    if (note.Pitches.length === 1 && note.Pitches[0].Degree === '%') {
      if (this.Meta.PitchQueue.length >= this.Settings.Trace) {
        const delta = this.parseDeltaPitch(note.PitOp)
        const queue = this.Meta.PitchQueue[this.Meta.PitchQueue.length - this.Settings.Trace]
        pitchQueue.push(...queue)
        pitches.push(...[].concat(...queue.map((pitch) => this.Settings.Key.map((key) => key - this.Settings.Key[0] + pitch + delta))))
        volumes.push(...[].concat(...new Array(queue.length).fill(this.getVolume(note.VolOp + note.Pitches[0].VolOp))))
      } else {
        this.warn(TmError.Types.Note.NoPrevious, { Expected: this.Settings.Trace, Actual: this.Meta.PitchQueue.length })
      }
    } else {
      for (const pitch of note.Pitches) {
        if (pitch.Degree === '0') continue
        if (pitch.Degree === 'x') {
          pitches.push(null)
          volumes.push(this.Settings.Volume[0] * note.VolOp.split('').reduce((sum, cur) => sum * cur === '>' ? this.Settings.Accent : cur === ':' ? this.Settings.Light : 1, 1))
        } else if (pitch.Chord === '') {
          const temp = this.parsePitch(pitch, note.PitOp)
          pitchQueue.push(temp[0])
          pitches.push(...temp)
          volumes.push(...this.getVolume(note.VolOp + pitch.VolOp))
        } else {
          const basePitch = this.parsePitch(pitch, note.PitOp)
          const chords = this.parseChord(pitch)
          pitchQueue.push(...chords.map(subPitch => subPitch + basePitch[0]))
          pitches.push(...[].concat(...chords.map((subPitch) => basePitch.map((delta) => subPitch + delta))))
          volumes.push(...[].concat(...new Array(chords.length).fill(this.getVolume(note.VolOp + pitch.VolOp))))
        }
      }
    }
    if (!volumes.every((vol) => vol <= 1)) {
      this.warn(TmError.Types.Note.VolumeLimit, { Actual: volumes })
      volumes.forEach((vol, index, arr) => {
        if (vol > 1) {
          arr[index] = 1
        }
      })
    }
    if (NoteParser.isDup(pitches)) {
      this.warn(TmError.Types.Note.Reduplicate, { Actual: pitches })
    }
    if (pitchQueue.length > 0) {
      this.Meta.PitchQueue.push(pitchQueue.slice(0))
    }

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

  getVolume(volOp) {
    const scale = volOp.split('').reduce((sum, cur) => sum * (cur === '>' ? this.Settings.Accent : (cur === ':' ? this.Settings.Light : 1)), 1)
    const total = this.Settings.Key.length
    const vol = this.Settings.Volume.length
    return [...this.Settings.Volume, ...new Array(total - vol).fill(this.Settings.Volume[vol - 1])].map((v) => v * scale)
  }

  parseChord(pitch) {
    return pitch.Chord.split('').reduce((pitches, chord) => {
      const operator = this.Chord[chord]
      const res = []
      const length = pitches.length
      const all = new Array(length).fill(true)
      operator.forEach(([head, tail, delta]) => {
        if (head < 0) {
          if (head < -length) {
            this.warn(TmError.Types.Note.ChordRange, { Expected: -length, Actual: head })
          }
          head += length
        } else if (head >= length) {
          this.warn(TmError.Types.Note.ChordRange, { Expected: length - 1, Actual: head })
        }
        if (tail < 0) {
          if (tail < -length) {
            this.warn(TmError.Types.Note.ChordRange, { Expected: -length, Actual: tail })
          }
          tail += length
        } else if (tail >= length) {
          this.warn(TmError.Types.Note.ChordRange, { Expected: length - 1, Actual: tail })
        }
        for (let i = head; i <= tail; i++) {
          all[i] = false
        }
        res.push(...pitches.slice(head, tail + 1).map((pitch) => pitch + delta))
      })
      if (!all.every((e) => !e)) this.warn(TmError.Types.Note.ChordOverride, {})
      return res
    }, [0])
  }

  parsePitch(pitch, base) {
    const delta = this.parseDeltaPitch(base) + NoteParser.pitchDict[pitch.Degree] + this.parseDeltaPitch(pitch.PitOp)
    return this.Settings.Key.map((key) => key + delta)
  }

  parseDeltaPitch(pitchOperators) {
    return pitchOperators.split('').reduce((sum, cur) => sum + NoteParser.pitchOperatorDict[cur], 0)
  }

  parseBeat(note) {
    let duration = 1
    let pointer = 0
    let dotCount = 0
    const length = note.DurOp.length
    while (pointer < length) {
      const char = note.DurOp.charAt(pointer)
      pointer += 1
      switch (char) {
      case '=':
        duration /= 4
        break
      case '-':
        duration += 1
        break
      case '_':
        duration /= 2
        break
      case '.':
        dotCount = 1
        while (note.DurOp.charAt(pointer) === '.') {
          dotCount += 1
          pointer += 1
        }
        duration *= 2 - Math.pow(2, -dotCount)
        break
      }
    }
    return duration * Math.pow(2, -this.Settings.Duration)
  }
}

NoteParser.pitchDict = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11 }
NoteParser.pitchOperatorDict = { '#': 1, 'b': -1, '\'': 12, ',': -12 }

module.exports = { NoteParser, PitchParser }
