import net.kakoen.valheim.save.decode.StableHashCode;
import java.util.*;
public class TryHash {
  static int[] targets = {1411875912,-1161852777,538325542,-494364525,-2119951934,-2129458801,686545676,650075310,-502993694,-62980316,109649212,1792656179,1272849455,-1195767551,1341839349,-2053541920};
  public static void main(String[] a) {
    Set<Integer> t = new HashSet<>();
    for(int h:targets) t.add(h);
    String[] names = {"itemstand","sign_notext","Turret","BlackMarble_Stair",
    "YggaShoot1","YggaShoot2","YggaShoot_small1","YggdrasilBranch",
    "Mistlands_rock1","Mistlands_rock2","Pickable_Mushroom_Magecap",
    "Pickable_Mushroom_JotunPuffs","Pickable_Yggashoot",
    "Birch1","Birch2","Birch2_aut","Birch1_aut","Oak1",
    "FirTree_log","Beech_log","Beech_small1","Beech_small2",
    "SwampTree2","SwampTree2_log","ShroomStump",
    "Gjall","Seeker","SeekerBrute","SeekerSoldier","Tick",
    "Dverger","DvergerMage","DvergerMageFireLarge",
    "Fallen_Valkyrie","Fader","Morgen","CrawlerMelee",
    "Charred_Melee","Charred_Archer","Charred_Mage","Charred_Twitcher",
    "Asksvin","Volture","BlobTar",
    "SapCollector","piece_sapcollector",
    "AshTree1","AshTree2","AshTree2_log","AshLog",
    "cinder_tree1","cinder_tree2","cinder_tree3",
    "AshlandsTree1","AshlandsTree2","Vine","VineAsh_big","VineAsh_small",
    "Pickable_Grausten","GrauBranch","GrauVine","Grausten_pile",
    "piece_dvergr_lantern","piece_dvergr_lantern_pole",
    "BossStone_Bonemass","BossStone_DragonQueen","BossStone_Fader",
    "piece_bench01","piece_table_oak","piece_chair02","piece_throne01",
    "piece_crafting_piece_blackforge","piece_galdr_table","piece_blackforge",
    "piece_spinning_wheel","piece_fermenter","piece_blast_furnace",
    "piece_windmill","piece_stonecutter_new",
    "AshlandsRockFormation1","AshlandsRockFormation2",
    "RockFormation1_Frac","RockFormation2_Frac","RockFormation3_Frac",
    "stone_pile","Stone_pile","rockformation_cone","RockFormation_Cone",
    "GoblinTotem","goblinking","GoblinKing","Fader_ragdoll",
    "piece_grausten_arch","piece_ashwood_arch","piece_ashwood_rafter",
    "piece_ashwood_floor","piece_ashwood_wall_1","piece_ashwood_pole",
    "piece_ashwood_stair","piece_ashwood_beam",
    "piece_ashlog_beam","piece_ashlog_floor","piece_ashlog_wall_1",
    "piece_ashlog_rafter","piece_ashlog_stair","piece_ashlog_arch",
    "woodwall_1x1", "woodwall_2x2", "woodwall_2x2_ribs"};
    boolean found = false;
    for(String n:names){ int h=StableHashCode.getStableHashCode(n); if(t.contains(h)){System.out.println(h+" = "+n);found=true;}}
    if(!found) System.out.println("No new matches.");
  }
}
