exports.computeCharacterStats = function computeCharacterStats(character, equipment = {}, effects = []) {
  const raw = character?.stats || {};

  const coreStats = {
    vitality: Number(raw.vitality ?? 0),
    strength: Number(raw.strength ?? 0),
    dexterity: Number(raw.dexterity ?? 0),
    intelligence: Number(raw.intelligence ?? 0),
    perception: Number(raw.perception ?? 0),
    luck: Number(raw.luck ?? 0),
  };

  const derivedStats = {
    maxHP: Math.round(50 + coreStats.vitality * 10),
    maxMana: Math.round(20 + coreStats.intelligence * 8),
    stamina: Math.round(30 + coreStats.vitality * 4 + coreStats.dexterity * 2),

    physicalPower: Math.round(5 + coreStats.strength * 2),
    spellPower: Math.round(5 + coreStats.intelligence * 2),

    armor: Math.round(coreStats.vitality * 1.5 + coreStats.strength * 0.5),
    accuracy: Math.round(75 + coreStats.perception * 2 + coreStats.dexterity),
    evasion: Math.round(coreStats.dexterity * 2 + coreStats.perception),

    critChance: Number((5 + coreStats.luck * 0.5 + coreStats.perception * 0.25).toFixed(1)),
    critDamage: Number((150 + coreStats.strength * 1.5).toFixed(1)),

    swingSpeed: Number((1 + coreStats.dexterity * 0.02).toFixed(2)),
    castSpeed: Number((1 + coreStats.intelligence * 0.015).toFixed(2)),
    moveSpeed: Math.round(100 + coreStats.dexterity * 0.4),

    hpRegen: Number((0.5 + coreStats.vitality * 0.12).toFixed(2)),
    manaRegen: Number((0.5 + coreStats.intelligence * 0.1).toFixed(2)),

    lootFind: Number((coreStats.luck * 1.5).toFixed(1)),
    detectRange: Math.round(coreStats.perception * 3),
  };

  return { coreStats, derivedStats };
};