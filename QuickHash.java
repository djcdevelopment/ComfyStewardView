import net.kakoen.valheim.save.decode.StableHashCode;
public class QuickHash {
  public static void main(String[] a) {
    int[] targets = {109649212, 1272849455, 538325542, -2119951934, -502993694, 1792656179, 1341839349, 1411875912, -1161852777, 686545676, -2053541920};
    java.util.Set<Integer> t = new java.util.HashSet<>();
    for(int h:targets) t.add(h);
    // Try LOTS of item names
    String[] names = {
      "TurretBolt","BoltBone","BoltIron","BoltBlackmetal","BoltCarapace","BoltCharred",
      "ArrowCarapace","ArrowCharred","ArrowAshlands","ArrowPoison",
      "SerpentStew","BloodPudding","FishWraps","WolfMeatSkewer","MinorEitr","EitrMead",
      "MeadEitrMinor","MeadEitrMajor","MeadStaminaMajor","MeadHealthMajor",
      "MeadHealthMinor","MeadHealthMedium","MeadPoisonResistance",
      "MeadTasty","MeadBaseEitrMajor","MeadBaseEitrMinor",
      "AskHide","AsksvinHide","AsksvinScale","AsksvinMeat","VoltureFeather","VoltureEgg",
      "FallenValkyriePlume","MorgenHeart","CharcoalResin","MarbledGlands",
      "Eitr","EitrOre","CrystalBat","Grausten","Ashwood","GrauVine",
      "BombBile","BombOoze","BombSiege","BombLava",
      "ValheimItem","ServerCoin","EventTicket","ServerToken",
      "TrophyGjall_2","TrophySeeker_2",
      "piece_dvergr_lantern","piece_dvergr_lantern_pole",
      "piece_brazierceiling01","piece_walltorch_iron",
      "piece_groundtorch_green","piece_groundtorch_blue","piece_groundtorch_mist",
      "CrystalLight","piece_crystal","piece_standing_iron_torch",
      "piece_brazier_oval","piece_maypole",
      "piece_blackmarble_tile_floor_1x1","piece_blackmarble_tile_wall",
      "blackmarble_tile_floor","blackmarble_tile_wall",
      "piece_blackmarble_column_1","piece_blackmarble_column_2",
      "piece_blackmarble_column_3","piece_blackmarble_ribs",
      "piece_blackmarble_slope_1x2","piece_blackmarble_out_2",
      "blackmarble_column_1","blackmarble_column_2","blackmarble_column_3",
      "blackmarble_ribs","blackmarble_slope_1x2","blackmarble_out_2",
      "piece_stone_beehive","piece_stone_column",
      "piece_shieldgenerator","piece_ward",
      "wood_log_stack","stone_pile","Pickable_RoyalJelly",
      "SapCollector","BeeHive","piece_beehive",
      "RuneStone_Draugr","RuneStone_Plains","RuneStone_BlackForest",
      "RuneStone_Swamps","RuneStone_Bonemass",
      "RuneStone_Ashlands","RuneStone_Mistlands","RuneStone_Mountains",
      "RuneStone_Boars","RuneStone_Greydwarfs",
      "Vegvisir_Bonemass","Vegvisir_GoblinKing","Vegvisir_DragonQueen",
      "Vegvisir_SeekerQueen","Vegvisir_Fader",
      "piece_sign_ashlands","piece_sign_mistlands","piece_text_large",
      "HildirQuestItem1","HildirQuestItem2","HildirQuestItem3",
      "GrauDvergr","Dvergr_plate","GoblinTotem","SeekerEgg","GjallEgg",
      "Pickable_DvalinnMimir","Pickable_MagecapGrown","Pickable_JotunPuffsGrown",
      "piece_blackmarble_floor_triangle","BlackMarble_floor_triangle",
      "darkwood_pole","darkwood_beam","darkwood_rafter","darkwood_base",
      "darkwood_base_height",
      "piece_darkwood_pole","piece_darkwood_beam","piece_darkwood_rafter",
      "piece_darkwood_gate","piece_darkwood_base","piece_darkwood_wall",
      "piece_dvergr_wood_wall","piece_dvergr_wood_wall_half",
      "piece_dvergr_wood_door","piece_dvergr_wood_stair",
      "piece_dvergr_suction_tube","piece_dvergr_cradle",
      "piece_dvergr_pole_small","piece_dvergr_pole_large",
      "piece_dvergr_ribs","piece_dvergr_arch",
      "dvergr_wood_pole","dvergr_wood_beam","dvergr_wood_wall",
      "dvergr_wood_stair","dvergr_ribs","dvergr_arch",
    };
    for(String n:names){
      int h=StableHashCode.getStableHashCode(n);
      if(t.contains(h)) System.out.println(h+" = '"+n+"'");
    }
    System.out.println("done");
  }
}
